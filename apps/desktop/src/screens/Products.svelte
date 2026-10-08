<script lang="ts">
  import { formatCents, parseCents } from '@mpf/shared';
  import type { LocalProduct } from '../lib/repo.ts';
  import { app, canAdmin, saveProduct } from '../lib/state.svelte.ts';

  interface Draft {
    id: string | null;
    name: string;
    category: string;
    price: string;
    trackStock: boolean;
    active: boolean;
    stock: string;
  }
  let draft = $state<Draft | null>(null);
  let busy = $state(false);
  let error = $state('');

  const symbol = $derived(app.context?.store.currencySymbol ?? '');

  const blank = (): Draft => ({ id: null, name: '', category: '', price: '', trackStock: true, active: true, stock: '0' });
  const edit = (p: LocalProduct): Draft => ({
    id: p.id,
    name: p.name,
    category: p.category,
    price: formatCents(p.priceCents),
    trackStock: p.trackStock,
    active: p.active,
    stock: String(p.stockQty ?? 0),
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!draft) return;
    const priceCents = parseCents(draft.price);
    const stockQty = Number(draft.stock);
    if (priceCents === null) return void (error = 'Escribe un precio válido.');
    if (draft.trackStock && (!Number.isInteger(stockQty) || stockQty < 0)) {
      return void (error = 'Las existencias deben ser un número entero, cero o más.');
    }
    busy = true;
    const failure = await saveProduct(
      draft.id,
      { name: draft.name, category: draft.category, priceCents, trackStock: draft.trackStock, active: draft.active },
      draft.trackStock ? stockQty : null,
    );
    busy = false;
    error = failure ?? '';
    if (!failure) draft = null;
  }
</script>

<div class="split">
  <section>
    <div class="row">
      <h3>Productos</h3>
      <span class="spacer"></span>
      <button class="primary" disabled={!canAdmin()} onclick={() => { draft = blank(); error = ''; }}>
        Nuevo producto
      </button>
    </div>
    {#if !canAdmin()}
      <p class="banner warn">Para editar productos se necesita conexión. Reconéctate e ingresa de nuevo.</p>
    {/if}
    <table>
      <thead>
        <tr><th>Nombre</th><th>Categoría</th><th class="num">Precio</th><th class="num">Existencias aquí</th><th></th></tr>
      </thead>
      <tbody>
        {#each app.products as p (p.id)}
          <tr class:voided={!p.active} class:selected={draft?.id === p.id} onclick={() => { draft = edit(p); error = ''; }}>
            <td>{p.name}</td>
            <td>{p.category}</td>
            <td class="num">{formatCents(p.priceCents, symbol)}</td>
            <td class="num">{p.trackStock ? p.stockQty : '—'}</td>
            <td>{p.active ? '' : 'Oculto'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <section class="detail">
    {#if draft}
      <form class="card" onsubmit={save}>
        <h3>{draft.id ? 'Editar producto' : 'Nuevo producto'}</h3>
        <label>Nombre <input bind:value={draft.name} required maxlength="120" /></label>
        <label>Categoría <input bind:value={draft.category} maxlength="60" /></label>
        <label>Precio <input bind:value={draft.price} required inputmode="decimal" /></label>
        <label class="check"><input type="checkbox" bind:checked={draft.trackStock} /> Controlar existencias</label>
        {#if draft.trackStock}
          <label>
            Existencias en {app.context?.store.name}
            <input bind:value={draft.stock} inputmode="numeric" />
          </label>
        {/if}
        <label class="check"><input type="checkbox" bind:checked={draft.active} /> Visible en la pantalla de venta</label>
        <div class="row">
          <button type="button" onclick={() => (draft = null)}>Cancelar</button>
          <button class="primary" disabled={busy || !canAdmin()}>Guardar</button>
        </div>
        {#if error}<p class="error">{error}</p>{/if}
      </form>
    {:else}
      <p class="muted">Selecciona un producto para editarlo. Los precios y nombres aplican a todas las tiendas; las existencias son por tienda.</p>
    {/if}
  </section>
</div>
