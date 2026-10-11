<script lang="ts">
  import { BUSINESS_NAME } from '@mpf/brand';
  import logo from '@mpf/brand/logo.webp';
  import { app, saveSetup } from '../lib/state.svelte.ts';

  let apiUrl = $state(app.config?.apiUrl ?? 'http://localhost:8787');
  let terminalToken = $state(app.config?.terminalToken ?? '');
  let printerTarget = $state(app.config?.printerTarget ?? '');
  let paperColumns = $state(app.config?.paperColumns ?? 48);
  let cutter = $state(app.config?.cutter ?? true);
  let cashDrawer = $state(app.config?.cashDrawer ?? false);
  let busy = $state(false);
  let message = $state('');
  let failed = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    const error = await saveSetup({
      apiUrl: apiUrl.trim(),
      terminalToken: terminalToken.trim(),
      printerTarget: printerTarget.trim(),
      paperColumns,
      cutter,
      cashDrawer,
    });
    busy = false;
    failed = error !== null;
    message = error ?? 'Guardado.';
  }
</script>

<form class="card" onsubmit={submit}>
  {#if !app.config}
    <img class="logo" src={logo} alt="" />
    <h2 class="brand brand-name">{BUSINESS_NAME}</h2>
  {/if}
  <h2 class:brand={!app.config}>{app.config ? 'Ajustes' : 'Configurar esta caja'}</h2>
  <label>Dirección del servidor <input bind:value={apiUrl} required placeholder="https://…" /></label>
  <label>Token de la caja <input bind:value={terminalToken} required type="password" /></label>
  <label>
    Impresora
    <input bind:value={printerTarget} placeholder="Nombre en Windows o /dev/usb/lp0  (vacío: sin impresora)" />
  </label>
  <label>
    Ancho del papel
    <select bind:value={paperColumns}>
      <option value={48}>80 mm (48 caracteres)</option>
      <option value={32}>58 mm (32 caracteres)</option>
    </select>
  </label>
  <label class="check"><input type="checkbox" bind:checked={cutter} /> La impresora corta el papel sola</label>
  <label class="check">
    <input type="checkbox" bind:checked={cashDrawer} /> Abrir el cajón al cobrar en efectivo
  </label>
  <button class="primary" disabled={busy}>{busy ? 'Verificando…' : 'Guardar'}</button>
  {#if message}<p class={failed ? 'error' : 'muted'}>{message}</p>{/if}
</form>
