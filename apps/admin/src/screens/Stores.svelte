<script lang="ts">
  import type { ManagedTerminal, ReleaseRing } from '@mpf/shared';
  import { api, attempt, errorText } from '../lib/api.ts';
  import { currentStore, isOrgAdmin, panel, reloadStores } from '../lib/state.svelte.ts';

  interface StoreDraft {
    id: string | null;
    code: string;
    name: string;
    currencySymbol: string;
    /** Percent as typed, e.g. "8" or "8,5". */
    tax: string;
    taxIncluded: boolean;
  }

  let draft = $state<StoreDraft | null>(null);
  let terminals = $state<ManagedTerminal[]>([]);
  let newCode = $state('');
  let newName = $state('');
  /** Shown once, right after a register is created or its token replaced. */
  let issued = $state<{ name: string; token: string } | null>(null);
  let copied = $state(false);
  let busy = $state(false);
  let error = $state('');
  let message = $state('');

  const store = $derived(currentStore());
  const percent = (bps: number) => String(bps / 100).replace('.', ',');
  const parsePercent = (text: string) => {
    const n = Number(text.trim().replace(',', '.'));
    return text.trim() !== '' && n >= 0 && n <= 100 ? Math.round(n * 100) : null;
  };

  // Follow the store picked in the header.
  let shownStoreId: string | null = null;
  $effect(() => {
    const s = store;
    // Keep a just-issued token on screen unless the admin moved to another store.
    if (s?.id !== shownStoreId) issued = null;
    shownStoreId = s?.id ?? null;
    draft = s
      ? { id: s.id, code: s.code, name: s.name, currencySymbol: s.currencySymbol, tax: percent(s.taxRateBps), taxIncluded: s.taxIncluded }
      : null;
    if (s) void loadTerminals(s.id);
    else terminals = [];
  });

  async function loadTerminals(storeId: string) {
    try {
      const result = (await api.terminals(storeId)).terminals;
      if (panel.storeId === storeId) terminals = result;
    } catch (err) {
      error = errorText(err);
    }
  }

  async function saveStore(event: SubmitEvent) {
    event.preventDefault();
    if (!draft) return;
    const taxRateBps = parsePercent(draft.tax);
    if (taxRateBps === null) return void (error = 'El impuesto debe ser un porcentaje entre 0 y 100.');
    const { id, code, name, currencySymbol, taxIncluded } = draft;
    busy = true;
    let created: string | undefined;
    error =
      (await attempt(async () => {
        if (id) await api.patchStore(id, { name, currencySymbol, taxRateBps, taxIncluded });
        else created = (await api.createStore({ code, name, currencySymbol, taxRateBps, taxIncluded })).store.id;
      })) ?? '';
    busy = false;
    if (!error) {
      message = id ? 'Tienda guardada. Las cajas la reciben en su siguiente sincronización.' : 'Tienda creada. Ahora agrega sus cajas.';
      await reloadStores(created);
    }
  }

  async function addTerminal(event: SubmitEvent) {
    event.preventDefault();
    if (!store) return;
    const storeId = store.id;
    busy = true;
    error =
      (await attempt(async () => {
        const { terminal, token } = await api.createTerminal(storeId, { code: newCode, name: newName || `Caja ${newCode.toUpperCase()}` });
        issued = { name: terminal.name, token };
        copied = false;
        newCode = newName = '';
      })) ?? '';
    busy = false;
    await loadTerminals(storeId);
  }

  async function toggle(t: ManagedTerminal) {
    error = (await attempt(() => api.patchTerminal(t.storeId, t.id, { active: !t.active }))) ?? '';
    await loadTerminals(t.storeId);
  }

  async function setRing(t: ManagedTerminal, releaseRing: ReleaseRing) {
    error = (await attempt(() => api.patchTerminal(t.storeId, t.id, { releaseRing }))) ?? '';
    await loadTerminals(t.storeId);
  }

  // Asked for twice on purpose: replacing a token disconnects that register.
  let rotating = $state<string | null>(null);
  async function rotate(t: ManagedTerminal) {
    if (rotating !== t.id) return void (rotating = t.id);
    rotating = null;
    error =
      (await attempt(async () => {
        issued = { name: t.name, token: (await api.rotateToken(t.storeId, t.id)).token };
        copied = false;
      })) ?? '';
  }

  async function copy() {
    if (!issued) return;
    copied = (await attempt(() => navigator.clipboard.writeText(issued!.token))) === null;
  }

  const seen = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : 'Nunca';
</script>

<div class="split">
  <section>
    {#if store}
      <div class="row">
        <h3>Cajas de {store.name}</h3>
      </div>
      <table>
        <thead>
          <tr>
            <th>Código</th><th>Nombre</th><th class="optional">Versión</th><th>Actualizaciones</th>
            <th class="optional">Última conexión</th><th class="optional"></th><th></th>
          </tr>
        </thead>
        <tbody>
          {#each terminals as t (t.id)}
            <tr class:voided={!t.active}>
              <td>{t.code}</td>
              <td>{t.name}</td>
              <td class="optional">{t.appVersion ?? '—'}</td>
              <td>
                <select
                  value={t.releaseRing}
                  aria-label={`Actualizaciones de ${t.name}`}
                  onchange={(e) => setRing(t, e.currentTarget.value as ReleaseRing)}
                >
                  <option value="pilot">Piloto</option>
                  <option value="stable">Estable</option>
                </select>
              </td>
              <td class="optional">{seen(t.lastSeenAt)}</td>
              <td class="optional">{t.active ? '' : 'Desactivada'}</td>
              <td class="actions">
                <button onclick={() => rotate(t)}>{rotating === t.id ? '¿Seguro? Desconecta la caja' : 'Nuevo token'}</button>
                <button onclick={() => toggle(t)}>{t.active ? 'Desactivar' : 'Activar'}</button>
              </td>
            </tr>
          {:else}
            <tr><td colspan="7" class="muted">Esta tienda aún no tiene cajas.</td></tr>
          {/each}
        </tbody>
      </table>

      {#if issued}
        <div class="token">
          <strong>Token de {issued.name}</strong>
          <code>{issued.token}</code>
          <p class="muted">
            Cópialo ahora y escríbelo en la pantalla de configuración de esa caja. No se vuelve a mostrar.
          </p>
          <div class="row">
            <button onclick={copy}>{copied ? 'Copiado' : 'Copiar'}</button>
            <button onclick={() => (issued = null)}>Ya lo guardé</button>
          </div>
        </div>
      {/if}

      <form class="row" onsubmit={addTerminal}>
        <input bind:value={newCode} required maxlength="4" pattern="[A-Za-z0-9\-]+" placeholder="Código (ej. A)" aria-label="Código de la caja" />
        <input bind:value={newName} maxlength="120" placeholder="Nombre (ej. Caja principal)" aria-label="Nombre de la caja" />
        <button class="primary" disabled={busy}>Agregar caja</button>
      </form>
      <p class="muted">El código es el prefijo de los tiquetes de esa caja (A-0001, A-0002…).</p>
      <p class="muted">
        Las cajas <strong>piloto</strong> reciben cada versión nueva primero; las <strong>estables</strong>, cuando
        se confirma que funciona bien en las piloto.
      </p>
    {:else}
      <p class="muted">Crea la primera tienda en el formulario de la derecha.</p>
    {/if}
  </section>

  <section class="detail">
    {#if message}<p class="muted">{message}</p>{/if}
    {#if error}<p class="error">{error}</p>{/if}
    {#if draft}
      <form class="card" onsubmit={saveStore}>
        <h3>{draft.id ? 'Datos de la tienda' : 'Nueva tienda'}</h3>
        {#if !draft.id}
          <label>
            Código
            <input bind:value={draft.code} required maxlength="12" pattern="[A-Za-z0-9\-]+" placeholder="NORTE" />
          </label>
        {/if}
        <label>Nombre <input bind:value={draft.name} required maxlength="120" /></label>
        <label>Símbolo de moneda <input bind:value={draft.currencySymbol} required maxlength="4" /></label>
        <label>Impuesto (%) <input bind:value={draft.tax} required inputmode="decimal" /></label>
        <label class="check">
          <input type="checkbox" bind:checked={draft.taxIncluded} /> Los precios ya incluyen el impuesto
        </label>
        <div class="row">
          {#if !draft.id}<button type="button" onclick={() => reloadStores()}>Cancelar</button>{/if}
          <button class="primary" disabled={busy}>Guardar</button>
        </div>
      </form>
    {/if}
    {#if isOrgAdmin() && draft?.id !== null}
      <button onclick={() => { draft = { id: null, code: '', name: '', currencySymbol: '$', tax: '0', taxIncluded: true }; error = message = ''; }}>
        Nueva tienda
      </button>
    {/if}
  </section>
</div>
