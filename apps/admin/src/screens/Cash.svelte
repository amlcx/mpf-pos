<script lang="ts">
  import { type DateRange, type StoreCashSession, formatCents, presets, validRange } from '@mpf/shared';
  import { api, errorText } from '../lib/api.ts';
  import { currentStore } from '../lib/state.svelte.ts';

  let { storeId }: { storeId: string } = $props();

  // Drawers belong to business days, which the date pickers here select.
  const quick = presets();
  const QUICK_LABEL: [keyof typeof quick, string][] = [
    ['today', 'Hoy'],
    ['yesterday', 'Ayer'],
    ['week', '7 días'],
    ['month', 'Este mes'],
  ];

  let range = $state<DateRange>({ ...quick.week });
  let sessions = $state<StoreCashSession[]>([]);
  let selected = $state<StoreCashSession | null>(null);
  let loadError = $state('');

  const store = $derived(currentStore());
  const money = (cents: number) => formatCents(cents, store?.currencySymbol ?? '');
  const day = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = (iso: string) => new Date(iso).toLocaleTimeString('es-CO', { timeStyle: 'short' });
  const moved = (s: StoreCashSession, kind: 'in' | 'out') =>
    s.movements.filter((m) => m.kind === kind).reduce((sum, m) => sum + m.amountCents, 0);

  /** How the closing went, for the pill in each row. */
  function result(s: StoreCashSession): { label: string; tone: 'good' | 'bad' | 'warn' } {
    if (s.countedCents === null || s.expectedCents === null) return { label: 'Abierta', tone: 'warn' };
    const diff = s.countedCents - s.expectedCents;
    if (diff === 0) return { label: 'Cuadra', tone: 'good' };
    return { label: diff > 0 ? `Sobran ${money(diff)}` : `Faltan ${money(-diff)}`, tone: 'bad' };
  }

  let request = 0;
  async function reload() {
    if (!validRange(range)) return;
    const current = ++request;
    const { from, to } = $state.snapshot(range);
    let result: StoreCashSession[] = [];
    let error = '';
    try {
      result = (await api.cashSessions(storeId, from, to)).sessions;
    } catch (err) {
      error = errorText(err);
    }
    if (current !== request) return;
    sessions = result;
    loadError = error;
    if (selected) selected = sessions.find((s) => s.id === selected!.id) ?? null;
  }

  $effect(() => {
    void [range.from, range.to];
    void reload();
  });
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
    </div>
    {#if !validRange(range)}
      <p class="error">Elige una fecha inicial que no sea posterior a la final.</p>
    {/if}
    {#if loadError}<p class="error">{loadError}</p>{/if}

    <table>
      <thead>
        <tr>
          <th>Día</th><th>Caja</th><th class="optional">Abrió</th><th class="num optional">Base</th>
          <th class="num">Contado</th><th class="num optional">Esperado</th><th>Resultado</th>
        </tr>
      </thead>
      <tbody>
        {#each sessions as s (s.id)}
          {@const r = result(s)}
          <tr class:selected={selected?.id === s.id} onclick={() => (selected = s)}>
            <td class="nowrap">{day(s.businessDate)}</td>
            <td>{s.terminalCode}</td>
            <td class="optional">{s.openedByName}</td>
            <td class="num optional">{money(s.openingCents)}</td>
            <td class="num">{s.countedCents === null ? '—' : money(s.countedCents)}</td>
            <td class="num optional">{s.expectedCents === null ? '—' : money(s.expectedCents)}</td>
            <td><span class="pill {r.tone}">{r.label}</span></td>
          </tr>
        {:else}
          <tr><td colspan="7" class="muted hand">No hay cajas abiertas en estas fechas.</td></tr>
        {/each}
      </tbody>
    </table>
    <p class="muted">
      Esperado = base + ventas en efectivo + entradas − salidas, calculado por la caja al cerrar. Un día va de las
      5:00 a las 5:00.
    </p>
  </section>

  <section class="detail" class:open={selected !== null}>
    {#if selected}
      {@const s = selected}
      {@const r = result(s)}
      <button class="back" onclick={() => (selected = null)}>‹ Volver</button>
      <h3>{s.terminalName}, {day(s.businessDate)}</h3>
      <dl>
        <dt>Abierta por {s.openedByName}</dt><dd>{time(s.openedAt)}</dd>
        <dt>Base</dt><dd>{money(s.openingCents)}</dd>
        <dt>Entradas</dt><dd>+{money(moved(s, 'in'))}</dd>
        <dt>Salidas</dt><dd>−{money(moved(s, 'out'))}</dd>
        {#if s.expectedCents !== null && s.countedCents !== null}
          <dt class="total">Esperado</dt><dd>{money(s.expectedCents)}</dd>
          <dt>Contado</dt><dd>{money(s.countedCents)}</dd>
          <dt>Cerrada por {s.closedByName}</dt><dd>{time(s.closedAt!)}</dd>
        {/if}
      </dl>
      <p><span class="pill {r.tone}">{r.label}</span></p>
      {#if s.note}<p>Nota: {s.note}</p>{/if}

      <h3>Entradas y salidas</h3>
      {#if s.movements.length > 0}
        <table>
          <tbody>
            {#each s.movements as m (m.id)}
              <tr>
                <td class="nowrap">{time(m.createdAt)}</td>
                <td class="num">{m.kind === 'in' ? '+' : '−'}{money(m.amountCents)}</td>
                <td>{m.reason}<br /><small class="muted">{m.userName}</small></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="muted hand">Sin entradas ni salidas.</p>
      {/if}
    {:else}
      <p class="muted hand">Selecciona una caja para ver su apertura, sus movimientos y su cierre.</p>
    {/if}
  </section>
</div>
