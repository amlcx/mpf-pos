<script lang="ts">
  import { BUSINESS_NAME } from '@mpf/brand';
  import logo from '@mpf/brand/logo.webp';
  import { app, errorText, signIn } from '../lib/state.svelte.ts';

  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      if (!(await signIn(username, password))) error = 'Usuario o contraseña incorrectos.';
    } catch (err) {
      error = errorText(err);
    }
    busy = false;
    password = '';
  }
</script>

<form class="card" onsubmit={submit}>
  <img class="logo" src={logo} alt="" />
  <h2 class="brand brand-name">{BUSINESS_NAME}</h2>
  <p class="muted brand">
    {app.context?.store.name} · {app.context?.terminal.name} · {app.online ? 'En línea' : 'Sin conexión'}
  </p>
  <!-- svelte-ignore a11y_autofocus -->
  <label>Usuario <input bind:value={username} required autofocus autocomplete="off" /></label>
  <label>Contraseña <input bind:value={password} required type="password" /></label>
  <button class="primary" disabled={busy}>Ingresar</button>
  {#if error}<p class="error">{error}</p>{/if}
</form>
