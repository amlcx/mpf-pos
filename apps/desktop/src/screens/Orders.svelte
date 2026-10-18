<script lang="ts">
  import { AlertDialog, Pagination, ToggleGroup } from 'bits-ui';
  import {
    type DateRange,
    type ReportOrder,
    type StockConflict,
    formatCents,
    presets,
    summarize,
    validRange,
  } from '@mpf/shared';
  import type { LocalOrder } from '../lib/repo.ts';
  import {
    app,
    canAdmin,
    errorText,
    exportOrders,
    hasServerSession,
    loadConflicts,
    loadOrders,
    loadStoreOrders,
    printTicket,
    resolveConflict,
    retryFailedOrders,
    ticketPreview,
    voidAndResell,
    voidOrder,
  } from '../lib/state.svelte.ts';

  /** register: this PC's own orders, available offline. store: every register, from the server. */
  type Scope = 'register' | 'store';
  // Long ranges can hold thousands of orders; the table shows them a page at a time.
  const PAGE_SIZE = 50;

  const quick = presets();
  const QUICK_LABEL: [keyof typeof quick, string][] = [
    ['today', 'Hoy'],
    ['yesterday', 'Ayer'],
    ['week', '7 días'],
    ['month', 'Este mes'],
  ];

  let range = $state<DateRange>({ ...quick.today });
  let scope = $state<Scope>('register');
  let orders = $state<ReportOrder[]>([]);
  let loadError = $state('');
  let conflicts = $state<StockConflict[]>([]);
  let selected = $state<ReportOrder | null>(null);
  let message = $state('');
  let page = $state(1);

  const symbol = $derived(app.context?.store.currencySymbol ?? '');
  const money = (cents: number) => formatCents(cents, symbol);
  const summary = $derived(summarize(orders));
  const preview = $derived(selected ? ticketPreview(selected) : '');
  const SYNC_LABEL = { submitting: 'Enviando', pending: 'Por sincronizar', synced: 'Sincronizado', failed: 'Con error' };
  // Only this register's own orders carry sync information.
  const local = (o: ReportOrder) => ('syncStatus' in o ? (o as LocalOrder) : null);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const shown = $derived(orders.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE));

  // The quick buttons light up while the dates match one of them. Pressing the lit
  // one again would leave none pressed, so an empty value changes nothing.
  const quickKey = () =>
    QUICK_LABEL.find(([key]) => range.from === quick[key].from && range.to === quick[key].to)?.[0] ?? '';
  const setQuick = (key: string) => {
    if (key) range = { ...quick[key as keyof typeof quick] };
  };
  const setScope = (value: string) => {
    if (value) scope = value as Scope;
  };

  let request = 0;
  async function reload() {
    if (!validRange(range)) return;
    const current = ++request;
    const wanted = $state.snapshot(range);
    let result: ReportOrder[] = [];
    let error = '';
    try {
      result = scope === 'store' ? await loadStoreOrders(wanted) : await loadOrders(wanted);
    } catch (err) {
      error = errorText(err);
    }
    const open = canAdmin() ? await loadConflicts().catch(() => []) : [];
    if (current !== request) return; // a newer filter is already loading
    orders = result;
    loadError = error;
    conflicts = open;
    if (selected) selected = orders.find((o) => o.id === selected!.id) ?? null;
  }

  $effect(() => {
    // Re-run whenever the filter changes.
    void [range.from, range.to, scope];
    page = 1;
    void reload();
  });

  // The store view needs the server; fall back when it goes away.
  $effect(() => {
    if (scope === 'store' && !canAdmin()) scope = 'register';
  });

  async function exportCsv() {
    const label = scope === 'store' ? 'tienda' : `caja-${app.context?.terminal.code ?? ''}`;
    message = await exportOrders($state.snapshot(orders), label, $state.snapshot(range));
  }

  async function reprint() {
    if (!selected) return;
    message = (await printTicket(selected)) ?? (app.config?.printerTarget ? 'Enviado a la impresora.' : 'No hay impresora configurada.');
  }

  // The order being voided, while the cashier types the reason. `order` is
  // set when it can also be charged again: one of this register's own sales.
  let voiding = $state<{ orderId: string; ticketNumber: string; order?: ReportOrder } | null>(null);
  let voidReason = $state('');
  let voidBusy = $state(false);
  let reasonInput = $state<HTMLInputElement | null>(null);

  function askVoid(orderId: string, ticketNumber: string, order?: ReportOrder) {
    voiding = { orderId, ticketNumber, order };
    voidReason = '';
  }

  /** Voids, then the app moves to the sale screen with the same items to charge. */
  async function voidAndChangePayment() {
    if (!voiding?.order || voidBusy) return;
    voidBusy = true;
    const error = await voidAndResell($state.snapshot(voiding.order), voidReason.trim() || 'Cambio de método de pago');
    voidBusy = false;
    voiding = null;
    if (error) {
      message = error;
      await reload();
    }
  }

  async function confirmVoid(event: SubmitEvent) {
    event.preventDefault();
    if (!voiding || voidBusy) return;
    voidBusy = true;
    message = (await voidOrder(voiding.orderId, voidReason)) ?? `Pedido ${voiding.ticketNumber} anulado.`;
    voidBusy = false;
    voiding = null;
    await reload();
  }

  async function accept(conflict: StockConflict) {
    message = (await resolveConflict(conflict.id)) ?? '';
    await reload();
  }

  const canVoid = (o: ReportOrder) =>
    o.status === 'completed' && hasServerSession() && (local(o)?.syncStatus ?? 'synced') === 'synced';
</script>

<div class="split">
  <section>
    <div class="row filters">
      <ToggleGroup.Root type="single" class="row" aria-label="Fechas" bind:value={quickKey, setQuick}>
        {#each QUICK_LABEL as [key, label] (key)}
          <ToggleGroup.Item value={key}>{label}</ToggleGroup.Item>
        {/each}
      </ToggleGroup.Root>
      <input type="date" bind:value={range.from} max={range.to} aria-label="Desde" />
      <span class="muted">a</span>
      <input type="date" bind:value={range.to} min={range.from} aria-label="Hasta" />
      <span class="spacer"></span>
      {#if canAdmin()}
        <ToggleGroup.Root type="single" class="row" aria-label="Pedidos de" bind:value={() => scope, setScope}>
          <ToggleGroup.Item value="register">Esta caja</ToggleGroup.Item>
          <ToggleGroup.Item value="store">Toda la tienda</ToggleGroup.Item>
        </ToggleGroup.Root>
      {/if}
      <button class="primary" disabled={orders.length === 0} onclick={exportCsv}>Exportar CSV</button>
    </div>
    {#if !validRange(range)}
      <p class="error">Elige una fecha inicial que no sea posterior a la final.</p>
    {/if}
    {#if loadError}<p class="error">{loadError}</p>{/if}

    <div class="stats">
      <div class="stat main">
        <span>Ventas</span>
        <strong>{money(summary.salesCents)}</strong>
        <small>
          {plural(summary.orderCount, 'pedido', 'pedidos')} · promedio {money(summary.averageCents)}
        </small>
      </div>
      <div class="stat"><span>Efectivo</span><strong>{money(summary.cashCents)}</strong></div>
      <div class="stat"><span>Digital</span><strong>{money(summary.digitalCents)}</strong></div>
      <div class="stat">
        <span>Productos</span>
        <strong>{summary.itemCount}</strong>
        <small>vendidos</small>
      </div>
      <div class="stat">
        <span>Anulados</span>
        <strong>{summary.voidedCount}</strong>
        <small>{money(summary.voidedCents)}</small>
      </div>
      {#if summary.discountCount > 0}
        <div class="stat">
          <span>Tarjetas</span>
          <strong>{summary.discountCount}</strong>
          <small>{money(summary.discountCents)} de descuento</small>
        </div>
      {/if}
    </div>

    {#if conflicts.length > 0}
      <h3>Vendido de más sin conexión</h3>
      <table>
        <tbody>
          {#each conflicts as c (c.id)}
            <tr>
              <td>{c.ticketNumber}</td>
              <td>{c.productName}: {c.shortfall} más de lo que había</td>
              <td class="actions">
                <button onclick={() => accept(c)}>Aceptar</button>
                <button onclick={() => askVoid(c.orderId, c.ticketNumber)}>Anular pedido</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <div class="row">
      <h3>{scope === 'store' ? 'Pedidos de toda la tienda' : 'Pedidos de esta caja'}</h3>
      <span class="spacer"></span>
      {#if app.counts.failed > 0 && app.session?.user.role === 'admin'}
        <button onclick={async () => { await retryFailedOrders(); await reload(); }}>Reintentar</button>
      {/if}
    </div>
    <table>
      <thead>
        <tr><th>Tiquete</th><th>Hora</th><th>Cajero</th><th class="num">Total</th><th>Estado</th></tr>
      </thead>
      <tbody>
        {#each shown as o (o.id)}
          {@const mine = local(o)}
          <tr class:selected={selected?.id === o.id} class:voided={o.status === 'voided'} onclick={() => { selected = o; message = ''; }}>
            <td>{o.ticketNumber}</td>
            <td>{new Date(o.createdAt).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>{o.cashierName ?? ''}</td>
            <td class="num">{money(o.totalCents)}</td>
            <td>
              {#if o.status === 'voided'}<span class="pill bad">Anulado</span>{/if}
              {#if o.discountKind}<span class="pill warn">Tarjeta</span>{/if}
              {#if mine}
                <span class="pill {mine.syncStatus === 'synced' ? 'good' : mine.syncStatus === 'failed' ? 'bad' : 'warn'}">
                  {SYNC_LABEL[mine.syncStatus]}
                </span>
                {#if mine.oversold}<span class="pill warn">Vendido de más</span>{/if}
              {/if}
            </td>
          </tr>
        {:else}
          <tr><td colspan="5" class="muted hand">No hay pedidos en estas fechas.</td></tr>
        {/each}
      </tbody>
    </table>
    {#if orders.length > PAGE_SIZE}
      <Pagination.Root count={orders.length} perPage={PAGE_SIZE} bind:page class="row pages">
        {#snippet children({ pages, range })}
          <Pagination.PrevButton aria-label="Página anterior">‹</Pagination.PrevButton>
          {#each pages as item (item.key)}
            {#if item.type === 'ellipsis'}
              <span class="muted">…</span>
            {:else}
              <Pagination.Page page={item}>{item.value}</Pagination.Page>
            {/if}
          {/each}
          <Pagination.NextButton aria-label="Página siguiente">›</Pagination.NextButton>
          <span class="muted">{range.start}–{range.end} de {orders.length}</span>
        {/snippet}
      </Pagination.Root>
    {/if}
  </section>

  <section class="detail">
    {#if message}<p class="muted">{message}</p>{/if}
    {#if selected}
      <pre>{preview}</pre>
      {#if selected.voidReason}
        <p class="muted">Anulado por {selected.voidedByName ?? '?'}: {selected.voidReason}</p>
      {/if}
      {#if local(selected)?.syncError}<p class="error">{local(selected)?.syncError}</p>{/if}
      <div class="row">
        <button onclick={reprint}>Reimprimir</button>
        {#if canVoid(selected)}
          <button onclick={() => askVoid(selected!.id, selected!.ticketNumber, local(selected!) ? selected! : undefined)}>Anular</button>
        {/if}
        <button onclick={() => (selected = null)}>Cerrar</button>
      </div>
    {:else}
      <h3>Más vendidos</h3>
      {#if summary.topProducts.length > 0}
        <ol class="top">
          {#each summary.topProducts as p}
            <li><span>{p.name}</span><strong>{p.quantity}</strong><span class="muted">{money(p.totalCents)}</span></li>
          {/each}
        </ol>
      {:else}
        <p class="muted hand">Aún no hay ventas en estas fechas.</p>
      {/if}
      <p class="muted hand">Selecciona un pedido para ver su tiquete.</p>
    {/if}
  </section>
</div>

<AlertDialog.Root bind:open={() => voiding !== null, (open) => { if (!open && !voidBusy) voiding = null; }}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="overlay" />
    <AlertDialog.Content
      class="card modal"
      onOpenAutoFocus={(e) => { e.preventDefault(); reasonInput?.focus(); }}
    >
      <form onsubmit={confirmVoid}>
        <AlertDialog.Title>
          {#snippet child({ props })}<h3 {...props}>Anular pedido {voiding?.ticketNumber}</h3>{/snippet}
        </AlertDialog.Title>
        <AlertDialog.Description class="muted">
          Sus productos vuelven a las existencias. No se puede deshacer.
          {#if voiding?.order}
            Si solo cambia el método de pago, usa «Anular y cambiar método de pago»: los mismos productos, al mismo
            precio, pasan a la pantalla de venta para cobrarlos de nuevo.
          {/if}
        </AlertDialog.Description>
        <label>Motivo <input bind:this={reasonInput} bind:value={voidReason} required maxlength="300" /></label>
        <div class="row">
          <AlertDialog.Cancel type="button" disabled={voidBusy}>Cancelar</AlertDialog.Cancel>
          {#if voiding?.order}
            <button type="button" disabled={voidBusy} onclick={voidAndChangePayment}>
              Anular y cambiar método de pago
            </button>
          {/if}
          <AlertDialog.Action type="submit" class="primary" disabled={!voidReason.trim() || voidBusy}>
            Anular pedido
          </AlertDialog.Action>
        </div>
      </form>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
