<script lang="ts">
  import { BUSINESS_NAME } from '@mpf/brand';
  import logo from '@mpf/brand/logo.webp';
  import { onMount } from 'svelte';
  import { boot, panel, signOut } from './lib/state.svelte.ts';
  import Login from './screens/Login.svelte';
  import Cash from './screens/Cash.svelte';
  import Products from './screens/Products.svelte';
  import Sales from './screens/Sales.svelte';
  import Stores from './screens/Stores.svelte';
  import Users from './screens/Users.svelte';

  const TABS = [
    ['sales', 'Ventas'],
    ['cash', 'Cierres de caja'],
    ['products', 'Productos e inventario'],
    ['users', 'Usuarios'],
    ['stores', 'Tienda y cajas'],
  ] as const;
  let tab = $state<(typeof TABS)[number][0]>('sales');

  onMount(boot);
</script>

{#if !panel.ready}
  <main class="centered"><p>Cargando…</p></main>
{:else if !panel.user}
  <main class="centered"><Login /></main>
{:else}
  <header>
    <img class="logo" src={logo} alt="" />
    <strong class="brand-name">{BUSINESS_NAME}</strong>
    {#if panel.stores.length > 1}
      <select bind:value={panel.storeId} aria-label="Tienda">
        {#each panel.stores as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
      </select>
    {:else}
      <span class="muted">{panel.stores[0]?.name ?? ''}</span>
    {/if}
    <nav>
      {#each TABS as [id, label] (id)}
        <button class:active={tab === id} onclick={() => (tab = id)}>{label}</button>
      {/each}
    </nav>
    <span class="spacer"></span>
    <span class="who">{panel.user.name}</span>
    <button onclick={() => signOut()}>Salir</button>
  </header>
  <main>
    {#if tab === 'users'}
      <Users />
    {:else if tab === 'stores'}
      <Stores />
    {:else if !panel.storeId}
      <div class="centered"><p class="muted hand">Aún no hay tiendas. Crea la primera en “Tienda y cajas”.</p></div>
    {:else if tab === 'sales'}
      {#key panel.storeId}<Sales storeId={panel.storeId} />{/key}
    {:else if tab === 'cash'}
      {#key panel.storeId}<Cash storeId={panel.storeId} />{/key}
    {:else}
      {#key panel.storeId}<Products storeId={panel.storeId} />{/key}
    {/if}
  </main>
{/if}
