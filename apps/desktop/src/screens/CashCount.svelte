<script lang="ts">
  import { type CashCount, DENOMINATIONS, countCents, formatCents } from '@mpf/shared';

  /** Pieces counted per denomination; edited in place. */
  let { count = $bindable(), symbol }: { count: CashCount; symbol: string } = $props();

  const groups = [
    { title: 'Billetes', items: DENOMINATIONS.filter((d) => d.kind === 'bill') },
    { title: 'Monedas', items: DENOMINATIONS.filter((d) => d.kind === 'coin') },
  ];
  const total = $derived(countCents(count));

  function set(cents: number, text: string) {
    const pieces = Number(text);
    count[String(cents)] = Number.isSafeInteger(pieces) && pieces > 0 ? pieces : 0;
  }
</script>

<div class="counter">
  {#each groups as group (group.title)}
    <div>
      <h4>{group.title}</h4>
      {#each group.items as d (d.cents)}
        {@const pieces = count[String(d.cents)] ?? 0}
        <label class="denom">
          <span class="value">{formatCents(d.cents, symbol)}</span>
          <input
            type="number"
            min="0"
            step="1"
            inputmode="numeric"
            value={pieces || ''}
            placeholder="0"
            aria-label={`Cantidad de ${group.title.toLowerCase()} de ${formatCents(d.cents, symbol)}`}
            oninput={(e) => set(d.cents, e.currentTarget.value)}
          />
          <span class="sub">{pieces ? formatCents(pieces * d.cents, symbol) : ''}</span>
        </label>
      {/each}
    </div>
  {/each}
</div>
<p class="sum"><span>Total contado</span><strong>{formatCents(total, symbol)}</strong></p>
