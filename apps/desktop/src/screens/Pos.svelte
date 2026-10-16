<script lang="ts">
  import { Toggle, ToggleGroup } from 'bits-ui';
  import { type CartItem, type PaymentInput, computeTotals, discountCentsFor, formatCents } from '@mpf/shared';
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
  // Ticked in the payment pop-up when the customer hands in a filled loyalty card.
  let loyalty = $state(false);
  const discountKind = $derived(loyalty ? ('loyalty_card' as const) : null);
  const lineTotals = $derived(cart.map((i) => i.unitPriceCents * i.quantity));
  const totals = $derived(
    computeTotals(lineTotals, store.taxRateBps, store.taxIncluded, discountCentsFor(discountKind, lineTotals)),
  );

  const inCart = (id: string) => cart.find((i) => i.productId === id)?.quantity ?? 0;
  const left = (p: LocalProduct) => (p.available === null ? null : p.available - inCart(p.id));

  // A toggle group cannot hold an empty value, so "Todos" has a key of its own.
  const ALL = '*';
  const setCategory = (value: string) => {
    if (value) category = value === ALL ? '' : value;
  };
  const setMarking = (on: boolean) => {
    marking = on;
    category = '';
    notice = null;
  };

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

  function charge() {
    if (cart.length === 0) return;
    notice = null;
    loyalty = false;
    paying = true;
  }

  function closePayment() {
    paying = false;
    loyalty = false;
  }

  // Space would otherwise press whichever button was clicked last, usually a
  // product. A button fires on key release, so that is swallowed too.
  let spaceTaken = false;
  function onKeyUp(event: KeyboardEvent) {
    if (event.key !== ' ' || !spaceTaken) return;
    spaceTaken = false;
    event.preventDefault();
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && done && !paying) return void (done = null);
    if (paying || event.ctrlKey || event.metaKey || event.altKey) return;
    if ((event.target as HTMLElement).closest('input, select, textarea')) return;
    if (event.key === ' ') {
      event.preventDefault();
      spaceTaken = true;
      if (!event.repeat && !marking) charge();
      return;
    }
    if (!activeId) return;
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
      const result = await sell($state.snapshot(cart), payments, discountKind);
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
    closePayment();
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

<svelte:window onkeydown={onKey} onkeyup={onKeyUp} />

<div class="pos">
  <section class="catalog">
    <div class="row">
      <input bind:value={search} placeholder="Buscar…" />
      <ToggleGroup.Root type="single" class="row" aria-label="Categoría" bind:value={() => category || ALL, setCategory}>
        <ToggleGroup.Item value={ALL}>Todos</ToggleGroup.Item>
        {#each categories as c (c)}
          <ToggleGroup.Item value={c}>{c}</ToggleGroup.Item>
        {/each}
      </ToggleGroup.Root>
      <span class="spacer"></span>
      {#if madeOnDemand || marking}
        <Toggle.Root bind:pressed={() => marking, setMarking}>
          {marking ? 'Listo' : 'Marcar agotados'}
        </Toggle.Root>
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
        <p class="muted hand">No hay productos.</p>
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
      <p class="hint"><kbd>+</kbd> <kbd>−</kbd> cambian la cantidad del producto resaltado · <kbd>Espacio</kbd> cobra</p>
    {/if}
    <div class="totals">
      {#if totals.discountCents > 0}
        <p><span>Tarjeta de fidelidad</span><span>{formatCents(-totals.discountCents, symbol)}</span></p>
      {/if}
      {#if totals.taxCents > 0}
        <p><span>Subtotal</span><span>{formatCents(totals.subtotalCents, symbol)}</span></p>
        <p><span>Impuesto {String(store.taxRateBps / 100).replace('.', ',')}%</span><span>{formatCents(totals.taxCents, symbol)}</span></p>
      {/if}
      <p class="total"><span>Total</span><span>{formatCents(totals.totalCents, symbol)}</span></p>
      <div class="row">
        <button disabled={cart.length === 0} onclick={clear}>Vaciar</button>
        <button class="primary" disabled={cart.length === 0} onclick={charge}>
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
  <Payment
    itemsCents={lineTotals.reduce((sum, n) => sum + n, 0)}
    {totals}
    taxIncluded={store.taxIncluded}
    {symbol}
    {busy}
    bind:loyalty
    onconfirm={pay}
    oncancel={closePayment}
  />
{/if}
