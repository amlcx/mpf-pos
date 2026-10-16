<script lang="ts">
  import { DISCOUNT_BPS, type PaymentInput, type Totals, formatCents, parseCents } from '@mpf/shared';

  interface Props {
    /** Sum of the cart's lines, before any discount. */
    itemsCents: number;
    totals: Totals;
    taxIncluded: boolean;
    symbol: string;
    busy: boolean;
    /** The customer handed in a filled loyalty card. Changing it changes `totals`. */
    loyalty: boolean;
    onconfirm: (payments: PaymentInput[]) => void;
    oncancel: () => void;
  }
  let { itemsCents, totals, taxIncluded, symbol, busy, loyalty = $bindable(), onconfirm, oncancel }: Props = $props();

  // Whatever is not paid digitally is due in cash. Empty cash field = exact amount.
  let digitalText = $state('');
  let cashText = $state('');

  const totalCents = $derived(totals.totalCents);
  const money = (cents: number) => formatCents(cents, symbol);
  const digital = $derived(digitalText.trim() ? parseCents(digitalText) : 0);
  const cashDue = $derived(digital === null ? null : totalCents - digital);
  const cashTyped = $derived(cashText.trim() !== '');
  const tendered = $derived(cashTyped ? parseCents(cashText) : cashDue);
  const valid = $derived(
    digital !== null && cashDue !== null && cashDue >= 0 && tendered !== null && tendered >= cashDue,
  );
  const change = $derived(valid ? tendered! - cashDue! : 0);
  const problem = $derived(
    digital === null
      ? 'Revisa el monto digital.'
      : cashDue! < 0
        ? 'El monto digital es mayor que el total.'
        : tendered === null
          ? 'Revisa el efectivo recibido.'
          : tendered < cashDue!
            ? 'No alcanza para cubrir el total.'
            : '',
  );
  // What the cashier still has to collect, as the amounts are typed.
  const pending = $derived.by(() => {
    if (digital === null || cashDue! < 0 || tendered === null) return null;
    if (!cashTyped && cashDue! > 0) return { label: 'Por cobrar en efectivo', cents: cashDue!, settled: false };
    if (tendered < cashDue!) return { label: 'Falta', cents: cashDue! - tendered, settled: false };
    return { label: 'Cambio', cents: change, settled: true };
  });

  function reset() {
    digitalText = '';
    cashText = '';
  }

  function confirm(event: SubmitEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    const payments: PaymentInput[] = [];
    if (cashDue! > 0) payments.push({ method: 'cash', amountCents: cashDue!, tenderedCents: tendered! });
    if (digital! > 0) payments.push({ method: 'digital', amountCents: digital! });
    onconfirm(payments);
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && oncancel()} />

<div class="overlay">
  <form class="card pay" onsubmit={confirm}>
    <aside class="due">
      {#if totals.discountCents > 0}
        <p><span>Productos</span><span>{money(itemsCents)}</span></p>
        <p>
          <span>Tarjeta {DISCOUNT_BPS.loyalty_card / 100}%</span>
          <span>{money(-totals.discountCents)}</span>
        </p>
      {/if}
      {#if !taxIncluded && totals.taxCents > 0}
        <p><span>Impuesto</span><span>{money(totals.taxCents)}</span></p>
      {/if}
      <p class="total"><span>Total</span><span>{money(totalCents)}</span></p>
      <p class="muted"><span>Digital</span><span>{digital ? money(digital) : '—'}</span></p>
      <p class="muted">
        <span>Efectivo recibido</span>
        <span>{cashTyped && tendered !== null ? money(tendered) : '—'}</span>
      </p>
      <div class="pending" class:settled={pending?.settled}>
        <span>{pending?.label ?? 'Falta'}</span>
        <strong>{pending ? money(pending.cents) : '—'}</strong>
      </div>
    </aside>

    <section class="fields">
      <h2>Cobrar</h2>
      <label class="check" class:on={loyalty}>
        <input type="checkbox" bind:checked={loyalty} onchange={reset} />
        Tarjeta de fidelidad completa: {DISCOUNT_BPS.loyalty_card / 100}% de descuento
      </label>
      <div class="row">
        <button type="button" onclick={reset}>Todo en efectivo</button>
        <button type="button" onclick={() => { digitalText = formatCents(totalCents); cashText = ''; }}>
          Todo digital
        </button>
      </div>
      <label>
        Digital (tarjeta, QR…)
        <input bind:value={digitalText} inputmode="decimal" placeholder="0" />
      </label>
      <label>
        Efectivo recibido
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:value={cashText}
          inputmode="decimal"
          autofocus
          disabled={cashDue === 0}
          placeholder={cashDue === null ? '' : formatCents(Math.max(cashDue, 0))}
        />
      </label>
      {#if problem}
        <p class="error">{problem}</p>
      {:else}
        <p class="muted">
          Efectivo {money(cashDue!)} · Digital {money(digital!)}
          {#if !cashTyped && cashDue! > 0}· deja el efectivo vacío si pagan exacto{/if}
        </p>
      {/if}
      <div class="row">
        <button type="button" onclick={oncancel}>Cancelar</button>
        <button class="primary" disabled={!valid || busy}>{busy ? 'Guardando…' : 'Confirmar e imprimir'}</button>
      </div>
    </section>
  </form>
</div>
