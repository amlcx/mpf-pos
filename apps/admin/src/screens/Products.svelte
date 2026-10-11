<script lang="ts">
  import { type Product, formatCents, parseCents } from '@mpf/shared';
  import { api, attempt, errorText } from '../lib/api.ts';
  import { currentStore } from '../lib/state.svelte.ts';

  let { storeId }: { storeId: string } = $props();

  interface Draft {
    id: string | null;
    name: string;
    category: string;
    price: string;
    trackStock: boolean;
    active: boolean;
  }

  let products = $state<Product[]>([]);
  let search = $state('');
  let draft = $state<Draft | null>(null);
  let received = $state('');
  let counted = $state('');
  let busy = $state(false);
  let error = $state('');
  let message = $state('');

  const store = $derived(currentStore());
  const money = (cents: number) => formatCents(cents, store?.currencySymbol ?? '');
  const visible = $derived(
    products.filter((p) => `${p.name} ${p.category}`.toLowerCase().includes(search.trim().toLowerCase())),
  );
  const current = $derived(products.find((p) => p.id === draft?.id) ?? null);

  async function reload() {
    try {
      products = (await api.products(storeId)).products;
    } catch (err) {
      error = errorText(err);
    }
  }
  $effect(() => void reload());

  function open(p: Product | null) {
    draft = p
      ? { id: p.id, name: p.name, category: p.category, price: formatCents(p.priceCents), trackStock: p.trackStock, active: p.active }
      : { id: null, name: '', category: '', price: '', trackStock: true, active: true };
    received = counted = error = message = '';
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!draft) return;
    const priceCents = parseCents(draft.price);
    if (priceCents === null) return void (error = 'Escribe un precio válido.');
    const input = { name: draft.name, category: draft.category, priceCents, trackStock: draft.trackStock, active: draft.active };
    const { id } = draft;
    busy = true;
    error =
      (await attempt(async () => {
        const saved = id ? await api.patchProduct(id, input) : await api.createProduct(input);
        draft!.id = saved.id;
      })) ?? '';
    busy = false;
    if (!error) message = 'Producto guardado.';
    await reload();
  }

  /** Applies a whole number typed in one of the stock fields. */
  async function changeStock(text: string, kind: 'receive' | 'count') {
    const n = Number(text.trim());
    if (!current || text.trim() === '' || !Number.isInteger(n) || (kind === 'count' ? n < 0 : n === 0)) {
      return void (error = kind === 'count' ? 'Escribe un número entero, cero o más.' : 'Escribe un número entero distinto de cero.');
    }
    busy = true;
    error = (await attempt(() => api.changeStock(storeId, current.id, kind === 'count' ? { quantity: n } : { delta: n }))) ?? '';
    busy = false;
    if (!error) {
      message = 'Existencias actualizadas.';
      received = counted = '';
    }
    await reload();
  }

  async function toggleSoldOut() {
    if (!current) return;
    busy = true;
    error = (await attempt(() => api.setSoldOut(storeId, current.id, !current.soldOut))) ?? '';
    busy = false;
    message = '';
    await reload();
  }
</script>

<div class="split">
  <section>
    <div class="row">
      <input bind:value={search} placeholder="Buscar producto o categoría…" />
      <button class="primary" onclick={() => open(null)}>Nuevo producto</button>
    </div>
    <table>
      <thead>
        <tr>
          <th>Nombre</th><th>Categoría</th><th class="num">Precio</th>
          <th class="num">Existencias en {store?.name}</th><th></th>
        </tr>
      </thead>
      <tbody>
        {#each visible as p (p.id)}
          <tr class:voided={!p.active} class:selected={draft?.id === p.id} onclick={() => open(p)}>
            <td>{p.name}</td>
            <td>{p.category}</td>
            <td class="num">{money(p.priceCents)}</td>
            <td class="num">
              {#if !p.trackStock}—{:else if (p.stockQty ?? 0) < 0}<span class="pill bad">{p.stockQty}</span>{:else}{p.stockQty}{/if}
            </td>
            <td>
              {#if !p.active}Oculto{:else if p.soldOut}<span class="pill bad">Agotado</span>{/if}
            </td>
          </tr>
        {:else}
          <tr><td colspan="5" class="muted">No hay productos.</td></tr>
        {/each}
      </tbody>
    </table>
  </section>

  <section class="detail">
    {#if message}<p class="muted">{message}</p>{/if}
    {#if error}<p class="error">{error}</p>{/if}
    {#if draft}
      {#if current?.trackStock}
        <div class="card">
          <h3>Existencias en {store?.name}: {current.stockQty}</h3>
          <form class="row" onsubmit={(e) => { e.preventDefault(); void changeStock(received, 'receive'); }}>
            <input bind:value={received} inputmode="numeric" placeholder="Entrada (+) o salida (−)" aria-label="Unidades que entran o salen" />
            <button disabled={busy}>Aplicar</button>
          </form>
          <form class="row" onsubmit={(e) => { e.preventDefault(); void changeStock(counted, 'count'); }}>
            <input bind:value={counted} inputmode="numeric" placeholder="Conteo físico" aria-label="Conteo físico" />
            <button disabled={busy}>Fijar</button>
          </form>
          <p class="muted">“Aplicar” suma o resta unidades (por ejemplo 12 o -3). “Fijar” reemplaza la cantidad por lo contado.</p>
        </div>
      {:else if current}
        <div class="card">
          <h3>{current.soldOut ? 'Agotado' : 'Disponible'} en {store?.name}</h3>
          <p class="muted">Se prepara al momento y no lleva existencias. Los cajeros también lo marcan desde la caja.</p>
          <div class="row">
            <button disabled={busy} onclick={toggleSoldOut}>
              {current.soldOut ? 'Marcar disponible' : 'Marcar agotado'}
            </button>
          </div>
        </div>
      {/if}
      <form class="card" onsubmit={save}>
        <h3>{draft.id ? 'Editar producto' : 'Nuevo producto'}</h3>
        <p class="muted">El nombre y el precio aplican a todas las tiendas.</p>
        <label>Nombre <input bind:value={draft.name} required maxlength="120" /></label>
        <label>Categoría <input bind:value={draft.category} maxlength="60" /></label>
        <label>Precio <input bind:value={draft.price} required inputmode="decimal" /></label>
        <label class="check"><input type="checkbox" bind:checked={draft.trackStock} /> Controlar existencias</label>
        <label class="check"><input type="checkbox" bind:checked={draft.active} /> Visible en la pantalla de venta</label>
        <div class="row">
          <button type="button" onclick={() => (draft = null)}>Cerrar</button>
          <button class="primary" disabled={busy}>Guardar</button>
        </div>
      </form>
    {:else}
      <p class="muted">Selecciona un producto para editarlo o ajustar sus existencias en {store?.name}.</p>
    {/if}
  </section>
</div>
