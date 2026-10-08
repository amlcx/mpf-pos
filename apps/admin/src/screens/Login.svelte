<script lang="ts">
  import { BUSINESS_NAME } from '@mpf/brand';
  import logo from '@mpf/brand/logo.webp';
  import { panel, signIn } from '../lib/state.svelte.ts';

  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = (await signIn(username, password)) ?? '';
    busy = false;
    password = '';
  }
</script>

<form class="card" onsubmit={submit}>
  <img class="logo" src={logo} alt="" />
  <h2 class="brand brand-name">{BUSINESS_NAME}</h2>
  <p class="muted brand">Administración</p>
  <!-- svelte-ignore a11y_autofocus -->
  <label>Usuario <input bind:value={username} required autofocus autocomplete="username" /></label>
  <label>Contraseña <input bind:value={password} required type="password" autocomplete="current-password" /></label>
  <button class="primary" disabled={busy}>Ingresar</button>
  {#if error || panel.error}<p class="error">{error || panel.error}</p>{/if}
</form>
