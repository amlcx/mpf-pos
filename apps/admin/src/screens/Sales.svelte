<script lang="ts">
  import { BUSINESS_NAME } from '@mpf/brand';
  import {
    type DateRange,
    type ReportOrder,
    type StockConflict,
    changeDueCents,
    formatCents,
    ordersXlsx,
    presets,
    rangeBounds,
    summarize,
    validRange,
  } from '@mpf/shared';
  import { api, attempt, errorText } from '../lib/api.ts';
  import { currentStore } from '../lib/state.svelte.ts';

  let { storeId }: { storeId: string } = $props();

  // Long ranges can hold thousands of orders; the summary and the export always cover all of them.
  const MAX_ROWS = 300;
  const quick = presets();
  const QUICK_LABEL: [keyof typeof quick, string][] = [
    ['today', 'Hoy'],
    ['yesterday', 'Ayer'],
    ['week', '7 días'],
    ['month', 'Este mes'],
  ];

  let range = $state<DateRange>({ ...quick.today });
  let orders = $state<ReportOrder[]>([]);
  let conflicts = $state<StockConflict[]>([]);
  let selected = $state<ReportOrder | null>(null);
  let loadError = $state('');
  let message = $state('');

  const store = $derived(currentStore());
  const money = (cents: number) => formatCents(cents, store?.currencySymbol ?? '');
  const summary = $derived(summarize(orders));
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const when = (iso: string) => new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });

  let request = 0;
  async function reload() {
    if (!validRange(range)) return;
    const current = ++request;
    const { from, to } = rangeBounds($state.snapshot(range));
    let result: ReportOrder[] = [];
    let open: StockConflict[] = [];
    let error = '';
    try {
      [result, open] = await Promise.all([
        api.orders(storeId, from, to).then((r) => r.orders),
        api.conflicts(storeId).then((r) => r.conflicts),
      ]);
    } catch (err) {
      error = errorText(err);
    }
    if (current !== request) return; // a newer filter is already loading
    orders = result;
    conflicts = open;
    loadError = error;
    if (selected) selected = orders.find((o) => o.id === selected!.id) ?? null;
  }

  $effect(() => {
    void [range.from, range.to];
    void reload();
  });

  function exportExcel() {
    const wanted = $state.snapshot(range);
    const days = wanted.from === wanted.to ? wanted.from : `${wanted.from}_${wanted.to}`;
    const file = ordersXlsx($state.snapshot(orders), {
      businessName: BUSINESS_NAME,
      storeName: store?.name ?? '',
      range: wanted,
    });
    const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const url = URL.createObjectURL(new Blob([file as Uint8Array<ArrayBuffer>], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `pedidos-${store?.code.toLowerCase() ?? 'tienda'}_${days}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // The order being voided, while the admin types the reason.
  let voiding = $state<{ orderId: string; ticketNumber: string } | null>(null);
  let voidReason = $state('');

  async function confirmVoid(event: SubmitEvent) {
    event.preventDefault();
    if (!voiding) return;
    const { orderId, ticketNumber } = voiding;
    message = (await attempt(() => api.voidOrder(storeId, orderId, voidReason))) ?? `Pedido ${ticketNumber} anulado.`;
    voiding = null;
    await reload();
  }

  async function accept(conflict: StockConflict) {
    message = (await attempt(() => api.resolveConflict(storeId, conflict.id))) ?? '';
    await reload();
  }
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
      <button class="primary" disabled={orders.length === 0} onclick={exportExcel}>Exportar a Excel</button>
    </div>
    {#if !validRange(range)}
      <p class="error">Elige una fecha inicial que no sea posterior a la final.</p>
    {/if}
    {#if loadError}<p class="error">{loadError}</p>{/if}

    <div class="stats">
      <div class="stat main">
        <span>Ventas</span>
        <strong>{money(summary.salesCents)}</strong>
        <small>{plural(summary.orderCount, 'pedido', 'pedidos')} · promedio {money(summary.averageCents)}</small>
      </div>
      <div class="stat"><span>Efectivo</span><strong>{money(summary.cashCents)}</strong></div>
      <div class="stat"><span>Digital</span><strong>{money(summary.digitalCents)}</strong></div>
      <div class="stat"><span>Productos</span><strong>{summary.itemCount}</strong><small>vendidos</small></div>
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
                <button onclick={() => { voiding = { orderId: c.orderId, ticketNumber: c.ticketNumber }; voidReason = ''; }}>
                  Anular pedido
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <h3>Pedidos de {store?.name}</h3>
    <table>
      <thead>
        <tr><th>Tiquete</th><th>Hora</th><th>Cajero</th><th class="num">Total</th><th>Estado</th></tr>
      </thead>
      <tbody>
        {#each orders.slice(0, MAX_ROWS) as o (o.id)}
          <tr class:selected={selected?.id === o.id} class:voided={o.status === 'voided'} onclick={() => { selected = o; message = ''; }}>
            <td>{o.ticketNumber}</td>
            <td>{when(o.createdAt)}</td>
            <td>{o.cashierName ?? ''}</td>
            <td class="num">{money(o.totalCents)}</td>
            <td>
              {#if o.status === 'voided'}<span class="pill bad">Anulado</span>{/if}
              {#if o.discountKind}<span class="pill warn">Tarjeta</span>{/if}
            </td>
          </tr>
        {:else}
          <tr><td colspan="5" class="muted">No hay pedidos en estas fechas.</td></tr>
        {/each}
      </tbody>
    </table>
    {#if orders.length > MAX_ROWS}
      <p class="muted">
        Se muestran los {MAX_ROWS} más recientes de {orders.length}. El resumen y el archivo de Excel los incluyen todos.
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
      <h3>Pedido {selected.ticketNumber}</h3>
      <p class="muted">{when(selected.createdAt)} · {selected.cashierName ?? ''}</p>
      {#if selected.status === 'voided'}
        <p class="error">Anulado por {selected.voidedByName ?? '?'}: {selected.voidReason ?? ''}</p>
      {/if}
      <dl>
        {#each selected.lines as line (line.id)}
          <dt>{line.quantity} × {line.name}</dt>
          <dd>{money(line.lineTotalCents)}</dd>
        {/each}
        {#if selected.discountKind}
          <dt>Tarjeta de fidelidad</dt>
          <dd>{money(-selected.discountCents)}</dd>
        {/if}
        <dt class="total">Total</dt>
        <dd>{money(selected.totalCents)}</dd>
        {#each selected.payments as p (p.id)}
          <dt class="muted">{p.method === 'cash' ? 'Efectivo' : 'Digital'}</dt>
          <dd class="muted">{money(p.tenderedCents ?? p.amountCents)}</dd>
        {/each}
        {#if changeDueCents(selected) > 0}
          <dt class="muted">Cambio</dt>
          <dd class="muted">{money(changeDueCents(selected))}</dd>
        {/if}
      </dl>
      <div class="row">
        {#if selected.status === 'completed'}
          <button onclick={() => { voiding = { orderId: selected!.id, ticketNumber: selected!.ticketNumber }; voidReason = ''; }}>
            Anular
          </button>
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
      <p class="muted">Selecciona un pedido para ver su detalle.</p>
    {/if}
  </section>
</div>
