<script lang="ts">
  import { type PaymentInput, formatCents, parseCents } from '@mpf/shared';

  interface Props {
    totalCents: number;
    symbol: string;
    busy: boolean;
    onconfirm: (payments: PaymentInput[]) => void;
    oncancel: () => void;
  }
  let { totalCents, symbol, busy, onconfirm, oncancel }: Props = $props();

  // Whatever is not paid digitally is due in cash. Empty cash field = exact amount.
  let digitalText = $state('');
  let cashText = $state('');

  const digital = $derived(digitalText.trim() ? parseCents(digitalText) : 0);
  const cashDue = $derived(digital === null ? null : totalCents - digital);
  const tendered = $derived(cashText.trim() ? parseCents(cashText) : cashDue);
  const valid = $derived(
    digital !== null && cashDue !== null && cashDue >= 0 && tendered !== null && tendered >= cashDue,
  );
  const change = $derived(valid ? tendered! - cashDue! : 0);

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
  <form class="card" onsubmit={confirm}>
    <h2>Total {formatCents(totalCents, symbol)}</h2>
    <div class="row">
      <button type="button" onclick={() => { digitalText = ''; cashText = ''; }}>Todo en efectivo</button>
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
    {#if valid}
      <p class="muted">
        Efectivo {formatCents(cashDue!, symbol)} · Digital {formatCents(digital!, symbol)}
      </p>
      <p class="change">Cambio {formatCents(change, symbol)}</p>
    {:else}
      <p class="error">
        {cashDue !== null && cashDue < 0 ? 'El monto digital es mayor que el total.' : 'No alcanza para cubrir el total.'}
      </p>
    {/if}
    <div class="row">
      <button type="button" onclick={oncancel}>Cancelar</button>
      <button class="primary" disabled={!valid || busy}>{busy ? 'Guardando…' : 'Confirmar e imprimir'}</button>
    </div>
  </form>
</div>
