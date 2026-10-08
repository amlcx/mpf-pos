<script lang="ts">
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
    loadConflicts,
    loadOrders,
    loadStoreOrders,
    printTicket,
    resolveConflict,
    retryFailedOrders,
    ticketPreview,
    voidOrder,
  } from '../lib/state.svelte.ts';

  /** register: this PC's own orders, available offline. store: every register, from the server. */
  type Scope = 'register' | 'store';
  // Long ranges can hold thousands of orders; the summary and CSV always cover all of them.
  const MAX_ROWS = 300;

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

  const symbol = $derived(app.context?.store.currencySymbol ?? '');
  const money = (cents: number) => formatCents(cents, symbol);
  const summary = $derived(summarize(orders));
  const preview = $derived(selected ? ticketPreview(selected) : '');
  const SYNC_LABEL = { submitting: 'Enviando', pending: 'Por sincronizar', synced: 'Sincronizado', failed: 'Con error' };
  // Only this register's own orders carry sync information.
  const local = (o: ReportOrder) => ('syncStatus' in o ? (o as LocalOrder) : null);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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

  // The order being voided, while the admin types the reason.
  let voiding = $state<{ orderId: string; ticketNumber: string } | null>(null);
  let voidReason = $state('');

  function askVoid(orderId: string, ticketNumber: string) {
    voiding = { orderId, ticketNumber };
    voidReason = '';
  }

  async function confirmVoid(event: SubmitEvent) {
    event.preventDefault();
    if (!voiding) return;
    message = (await voidOrder(voiding.orderId, voidReason)) ?? `Pedido ${voiding.ticketNumber} anulado.`;
    voiding = null;
    await reload();
  }

  async function accept(conflict: StockConflict) {
    message = (await resolveConflict(conflict.id)) ?? '';
    await reload();
  }

  const canVoid = (o: ReportOrder) =>
    o.status === 'completed' && canAdmin() && (local(o)?.syncStatus ?? 'synced') === 'synced';
</script>

<div class="split">
  <section>
    <div class="row filters">
      {#each QUICK_LABEL as [key, label] (key)}
        <button
          class:active={range.from === quick[key].from && range.to === quick[key].to}
          onclick={() => (range = { ...quick[key] })}
        >
          {label}
        </button>
      {/each}
      <input type="date" bind:value={range.from} max={range.to} aria-label="Desde" />
      <span class="muted">a</span>
      <input type="date" bind:value={range.to} min={range.from} aria-label="Hasta" />
      <span class="spacer"></span>
      {#if canAdmin()}
        <button class:active={scope === 'register'} onclick={() => (scope = 'register')}>Esta caja</button>
        <button class:active={scope === 'store'} onclick={() => (scope = 'store')}>Toda la tienda</button>
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
        {#each orders.slice(0, MAX_ROWS) as o (o.id)}
          {@const mine = local(o)}
          <tr class:selected={selected?.id === o.id} class:voided={o.status === 'voided'} onclick={() => { selected = o; message = ''; }}>
            <td>{o.ticketNumber}</td>
            <td>{new Date(o.createdAt).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>{o.cashierName ?? ''}</td>
            <td class="num">{money(o.totalCents)}</td>
            <td>
              {#if o.status === 'voided'}<span class="pill bad">Anulado</span>{/if}
              {#if mine}
                <span class="pill {mine.syncStatus === 'synced' ? 'good' : mine.syncStatus === 'failed' ? 'bad' : 'warn'}">
                  {SYNC_LABEL[mine.syncStatus]}
                </span>
                {#if mine.oversold}<span class="pill warn">Vendido de más</span>{/if}
              {/if}
            </td>
          </tr>
        {:else}
          <tr><td colspan="5" class="muted">No hay pedidos en estas fechas.</td></tr>
        {/each}
      </tbody>
    </table>
    {#if orders.length > MAX_ROWS}
      <p class="muted">
        Se muestran los {MAX_ROWS} más recientes de {orders.length}. El resumen y el CSV los incluyen todos.
      </p>
    {/if}
  </section>

  <section class="detail">
    {#if message}<p class="muted">{message}</p>{/if}
    {#if voiding}
      <form class="card" onsubmit={confirmVoid}>
        <h3>Anular pedido {voiding.ticketNumber}</h3>
        <p class="muted">Sus productos vuelven a las existencias. No se puede deshacer.</p>
        <!-- svelte-ignore a11y_autofocus -->
        <label>Motivo <input bind:value={voidReason} required maxlength="300" autofocus /></label>
        <div class="row">
          <button type="button" onclick={() => (voiding = null)}>Cancelar</button>
          <button class="primary" disabled={!voidReason.trim()}>Anular pedido</button>
        </div>
      </form>
    {/if}
    {#if selected}
      <pre>{preview}</pre>
      {#if local(selected)?.syncError}<p class="error">{local(selected)?.syncError}</p>{/if}
      <div class="row">
        <button onclick={reprint}>Reimprimir</button>
        {#if canVoid(selected)}
          <button onclick={() => askVoid(selected!.id, selected!.ticketNumber)}>Anular</button>
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
        <p class="muted">Aún no hay ventas en estas fechas.</p>
      {/if}
      <p class="muted">Selecciona un pedido para ver su tiquete.</p>
    {/if}
  </section>
</div>
