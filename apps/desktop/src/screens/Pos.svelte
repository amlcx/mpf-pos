<script lang="ts">
  import { type CartItem, type PaymentInput, computeTotals, formatCents } from '@mpf/shared';
  import type { LocalOrder, LocalProduct } from '../lib/repo.ts';
  import { app, printTicket, sell, setSoldOut } from '../lib/state.svelte.ts';
  import Payment from './Payment.svelte';

  let cart = $state<CartItem[]>([]);
  let category = $state('');
  let search = $state('');
  let paying = $state(false);
  let busy = $state(false);
  let notice = $state<string | null>(null);
  // The sale just made, shown in a small pop-up until closed or the next sale starts.
  let done = $state<{ order: LocalOrder; synced: boolean; status: string; failed: boolean } | null>(null);
  // The product the + and - keys act on: the last one clicked or adjusted.
  let activeId = $state<string | null>(null);

  const store = $derived(app.context!.store);
  const symbol = $derived(store.currencySymbol);
  // While marking, the grid lists only made-on-demand products and a click
  // flips whether the store can still prepare them.
  let marking = $state(false);
  const selling = $derived(app.products.filter((p) => p.active && (!marking || !p.trackStock)));
  const madeOnDemand = $derived(app.products.some((p) => p.active && !p.trackStock));
  const categories = $derived([...new Set(selling.map((p) => p.category).filter(Boolean))]);
  const visible = $derived(
    selling.filter(
      (p) => (!category || p.category === category) && p.name.toLowerCase().includes(search.trim().toLowerCase()),
    ),
  );
  const totals = $derived(
    computeTotals(cart.map((i) => i.unitPriceCents * i.quantity), store.taxRateBps, store.taxIncluded),
  );

  const inCart = (id: string) => cart.find((i) => i.productId === id)?.quantity ?? 0;
  const left = (p: LocalProduct) => (p.available === null ? null : p.available - inCart(p.id));

  let toggling = $state(false);
  async function toggleSoldOut(p: LocalProduct) {
    if (toggling) return;
    toggling = true;
    notice = await setSoldOut(p.id, !p.soldOut);
    toggling = false;
  }

  function add(p: LocalProduct) {
    const remaining = left(p);
    if (remaining !== null && remaining <= 0) return;
    notice = null;
    done = null;
    activeId = p.id;
    const item = cart.find((i) => i.productId === p.id);
    if (item) item.quantity += 1;
    else cart.push({ productId: p.id, name: p.name, unitPriceCents: p.priceCents, quantity: 1 });
  }

  function remove(item: CartItem) {
    activeId = item.productId;
    item.quantity -= 1;
    if (item.quantity <= 0) cart = cart.filter((i) => i !== item);
  }

  function addById(productId: string) {
    const product = app.products.find((p) => p.id === productId);
    if (product) add(product);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && done && !paying) return void (done = null);
    if (paying || !activeId || event.ctrlKey || event.metaKey || event.altKey) return;
    if ((event.target as HTMLElement).closest('input, select, textarea')) return;
    // "=" is the unshifted "+" on most keyboards.
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      addById(activeId);
    } else if (event.key === '-') {
      event.preventDefault();
      const item = cart.find((i) => i.productId === activeId);
      if (item) remove(item);
    }
  }

  function clear() {
    cart = [];
    activeId = null;
  }

  async function pay(payments: PaymentInput[]) {
    busy = true;
    try {
      const result = await sell($state.snapshot(cart), payments);
      if (result.ok) {
        clear();
        const printError = await printTicket(result.order, true);
        done = {
          order: result.order,
          synced: result.synced,
          status: printError ? `No se pudo imprimir: ${printError}` : '',
          failed: printError !== null,
        };
      } else if (result.reason === 'insufficient_stock') {
        const names = result.items.map((i) => {
          const name = app.products.find((p) => p.id === i.productId)?.name ?? '?';
          return `${name} (quedan ${i.available})`;
        });
        notice = `No hay suficientes existencias: ${names.join(', ')}. Ajusta el pedido.`;
      } else {
        notice = `No se pudo crear el pedido: ${result.problems.join('; ')}`;
      }
    } catch (err) {
      notice = String(err);
    }
    busy = false;
    paying = false;
  }

  let printing = $state(false);
  async function printCopy() {
    if (!done || printing) return;
    if (!app.config?.printerTarget) {
      done.status = 'No hay impresora configurada.';
      done.failed = true;
      return;
    }
    printing = true;
    const error = await printTicket(done.order);
    printing = false;
    if (!done) return;
    done.status = error ? `No se pudo imprimir: ${error}` : 'Copia enviada a la impresora.';
    done.failed = error !== null;
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="pos">
  <section class="catalog">
    <div class="row">
      <input bind:value={search} placeholder="Buscar…" />
      <button class:active={category === ''} onclick={() => (category = '')}>Todos</button>
      {#each categories as c (c)}
        <button class:active={category === c} onclick={() => (category = c)}>{c}</button>
      {/each}
      <span class="spacer"></span>
      {#if madeOnDemand || marking}
        <button class:active={marking} onclick={() => { marking = !marking; category = ''; notice = null; }}>
          {marking ? 'Listo' : 'Marcar agotados'}
        </button>
      {/if}
    </div>
    {#if marking}
      <p class="hint">Toca un producto preparado al momento para marcarlo como agotado o disponible en esta tienda.</p>
    {/if}
    <div class="grid">
      {#each visible as p (p.id)}
        {@const remaining = left(p)}
        {@const quantity = inCart(p.id)}
        {#if marking}
          <button class="product" disabled={toggling} onclick={() => toggleSoldOut(p)}>
            <span class="name">{p.name}</span>
            <span class="stock" class:low={p.soldOut}>{p.soldOut ? 'Agotado' : 'Disponible'}</span>
          </button>
        {:else}
          <button
            class="product"
            class:current={activeId === p.id}
            disabled={remaining !== null && remaining <= 0}
            onclick={() => add(p)}
          >
            {#if quantity > 0}<span class="badge">{quantity}</span>{/if}
            <span class="name">{p.name}</span>
            <span>{formatCents(p.priceCents, symbol)}</span>
            {#if remaining !== null}
              <span class="stock" class:low={remaining <= 3}>{remaining > 0 ? `Quedan ${remaining}` : 'Agotado'}</span>
            {/if}
          </button>
        {/if}
      {:else}
        <p class="muted">No hay productos.</p>
      {/each}
    </div>
  </section>

  <section class="cart">
    {#if notice}
      <p class="notice error">{notice}</p>
    {/if}
    <ul>
      {#each cart as item (item.productId)}
        <li class:current={activeId === item.productId}>
          <button onclick={() => remove(item)} aria-label="Quitar uno">−</button>
          <span class="qty">{item.quantity}</span>
          <button onclick={() => addById(item.productId)} aria-label="Agregar uno">+</button>
          <span class="name">{item.name}</span>
          <span>{formatCents(item.unitPriceCents * item.quantity, symbol)}</span>
        </li>
      {/each}
    </ul>
    {#if activeId}
      <p class="hint"><kbd>+</kbd> <kbd>−</kbd> cambian la cantidad del producto resaltado</p>
    {/if}
    <div class="totals">
      {#if totals.taxCents > 0}
        <p><span>Subtotal</span><span>{formatCents(totals.subtotalCents, symbol)}</span></p>
        <p><span>Impuesto {String(store.taxRateBps / 100).replace('.', ',')}%</span><span>{formatCents(totals.taxCents, symbol)}</span></p>
      {/if}
      <p class="total"><span>Total</span><span>{formatCents(totals.totalCents, symbol)}</span></p>
      <div class="row">
        <button disabled={cart.length === 0} onclick={clear}>Vaciar</button>
        <button class="primary" disabled={cart.length === 0} onclick={() => { notice = null; paying = true; }}>
          Cobrar
        </button>
      </div>
    </div>
  </section>
</div>

{#if done}
  <div class="toast" role="status">
    <div>
      <strong>Tiquete {done.order.ticketNumber}</strong>
      <span class="muted">{done.synced ? 'Pedido creado' : 'Pedido guardado sin conexión'}</span>
      {#if done.status}<span class={done.failed ? 'error' : 'muted'}>{done.status}</span>{/if}
    </div>
    <button onclick={printCopy} disabled={printing}>{printing ? 'Imprimiendo…' : 'Imprimir copia'}</button>
    <button class="close" onclick={() => (done = null)} aria-label="Cerrar">×</button>
  </div>
{/if}

{#if paying}
  <Payment totalCents={totals.totalCents} {symbol} {busy} onconfirm={pay} oncancel={() => (paying = false)} />
{/if}
