//! Raw output through the Windows print spooler: the bytes reach the printer
//! untouched, whatever port (USB, serial, network) Windows has it on.

use std::ffi::c_void;
use std::io::Error;
use std::ptr;

use windows_sys::Win32::Graphics::Printing::{
    ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW, StartPagePrinter,
    WritePrinter, DOC_INFO_1W, PRINTER_HANDLE,
};

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn failed(step: &str, printer: &str) -> String {
    format!("{step} failed for printer {printer}: {}", Error::last_os_error())
}

/// `printer` is the name Windows shows for it, e.g. "XP-58".
pub fn print_raw(printer: &str, bytes: &[u8]) -> Result<(), String> {
    let name = wide(printer);
    let mut handle = PRINTER_HANDLE { Value: ptr::null_mut() };
    // SAFETY: `name` is NUL-terminated and outlives the call; `handle` is a valid out pointer.
    if unsafe { OpenPrinterW(name.as_ptr(), &mut handle, ptr::null()) } == 0 {
        return Err(failed("open", printer));
    }
    let result = send(handle, printer, bytes);
    // SAFETY: `handle` came from OpenPrinterW and is closed exactly once.
    unsafe { ClosePrinter(handle) };
    result
}

fn send(handle: PRINTER_HANDLE, printer: &str, bytes: &[u8]) -> Result<(), String> {
    let mut doc_name = wide("Ticket");
    let mut datatype = wide("RAW");
    let doc = DOC_INFO_1W {
        pDocName: doc_name.as_mut_ptr(),
        pOutputFile: ptr::null_mut(),
        pDatatype: datatype.as_mut_ptr(),
    };
    let length = u32::try_from(bytes.len()).map_err(|_| "ticket too large".to_string())?;
    // SAFETY: `handle` is open; `doc` and the strings it points to live until the job ends;
    // `bytes` is valid for `length` bytes and `written` is a valid out pointer.
    unsafe {
        if StartDocPrinterW(handle, 1, &doc) == 0 {
            return Err(failed("start job", printer));
        }
        let mut written = 0u32;
        let ok = StartPagePrinter(handle) != 0
            && WritePrinter(handle, bytes.as_ptr() as *const c_void, length, &mut written) != 0
            && written == length;
        let result = if ok { Ok(()) } else { Err(failed("write", printer)) };
        EndPagePrinter(handle);
        EndDocPrinter(handle);
        result
    }
}
