<script lang="ts">
  import { onMount } from 'svelte';
  import { BUSINESS_NAME } from '@mpf/brand';
  import logo from '@mpf/brand/logo.webp';
  import { app, boot, installUpdate, signOut, syncNow } from './lib/state.svelte.ts';
  import Login from './screens/Login.svelte';
  import Orders from './screens/Orders.svelte';
  import Pos from './screens/Pos.svelte';
  import Products from './screens/Products.svelte';
  import Setup from './screens/Setup.svelte';

  type Tab = 'sell' | 'orders' | 'products' | 'settings';
  let tab = $state<Tab>('sell');
  const isAdmin = $derived(app.session?.user.role === 'admin');
  const tabs = $derived<[Tab, string][]>([
    ['sell', 'Vender'],
    ['orders', 'Pedidos'],
    ...(isAdmin ? ([['products', 'Productos'], ['settings', 'Ajustes']] as [Tab, string][]) : []),
  ]);
  const waiting = $derived(app.counts.pending + app.counts.submitting);
  let updateError = $state('');
  async function install() {
    updateError = (await installUpdate()) ?? '';
  }

  onMount(boot);
</script>

{#if !app.ready}
  <main class="centered"><p>Iniciando…</p></main>
{:else if app.bootError}
  <main class="centered"><p class="error">No se pudo abrir la base de datos local: {app.bootError}</p></main>
{:else if !app.config || !app.context}
  <main class="centered"><Setup /></main>
{:else if !app.session}
  <main class="centered"><Login /></main>
{:else}
  <header>
    <img class="logo" src={logo} alt="" />
    <strong class="brand-name">{BUSINESS_NAME}</strong>
    <span class="muted">{app.context.store.name} · {app.context.terminal.name}</span>
    <nav>
      {#each tabs as [id, label] (id)}
        <button class:active={tab === id} onclick={() => (tab = id)}>{label}</button>
      {/each}
    </nav>
    <span class="spacer"></span>
    {#if app.counts.failed > 0}
      <span class="pill bad">{app.counts.failed} con error</span>
    {/if}
    {#if waiting > 0}
      <span class="pill warn">{waiting} por sincronizar</span>
    {/if}
    <button class="pill {app.online ? 'good' : 'bad'}" title={app.syncError} onclick={syncNow}>
      {app.online ? 'En línea' : 'Sin conexión'}
    </button>
    <span>{app.session.user.name}</span>
    <button onclick={() => { signOut(); tab = 'sell'; }}>Salir</button>
  </header>
  {#if app.update.status === 'ready'}
    <div class="banner good" role="status">
      <strong>Actualización lista</strong>
      <span>Versión {app.update.version}. Se instala en menos de un minuto y la caja se abre de nuevo.</span>
      <button class="primary" disabled={app.saleOpen} onclick={install}>Instalar ahora</button>
      {#if app.saleOpen}<span class="hand">Termina la venta en curso para instalarla.</span>{/if}
      {#if updateError}<span class="error">{updateError}</span>{/if}
    </div>
  {:else if app.update.status === 'installing'}
    <p class="banner good" role="status">Instalando la versión {app.update.version}… la caja se abre de nuevo sola.</p>
  {/if}
  {#if app.syncError}
    <p class="banner error">{app.syncError}</p>
  {:else if !app.online}
    <p class="banner warn">
      Sin conexión. Las ventas se guardan en este computador y se envían cuando vuelva la conexión.
      Las existencias mostradas pueden estar desactualizadas.
    </p>
  {/if}
  <main>
    {#if tab === 'sell'}
      <Pos />
    {:else if tab === 'orders'}
      <Orders />
    {:else if tab === 'products' && isAdmin}
      <Products />
    {:else if tab === 'settings' && isAdmin}
      <div class="centered"><Setup /></div>
    {/if}
  </main>
{/if}
