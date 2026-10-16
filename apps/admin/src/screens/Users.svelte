<script lang="ts">
  import { ADMIN_PASSWORD_MIN, type ManagedUser, type Role, type UserPatch } from '@mpf/shared';
  import { api, attempt, errorText } from '../lib/api.ts';
  import { isOrgAdmin, panel } from '../lib/state.svelte.ts';

  interface Draft {
    id: string | null;
    username: string;
    name: string;
    role: Role;
    /** '' means every store. */
    storeId: string;
    active: boolean;
    password: string;
  }

  let users = $state<ManagedUser[]>([]);
  let draft = $state<Draft | null>(null);
  let busy = $state(false);
  let error = $state('');
  let message = $state('');

  const storeName = (id: string | null) =>
    id === null ? 'Todas' : (panel.stores.find((s) => s.id === id)?.name ?? '—');

  async function reload() {
    try {
      users = (await api.users()).users;
    } catch (err) {
      error = errorText(err);
    }
  }
  $effect(() => void reload());

  function open(u: ManagedUser | null) {
    draft = u
      ? { id: u.id, username: u.username, name: u.name, role: u.role, storeId: u.storeId ?? '', active: u.active, password: '' }
      : { id: null, username: '', name: '', role: 'cashier', storeId: panel.user?.storeId ?? panel.storeId ?? '', active: true, password: '' };
    error = message = '';
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!draft) return;
    const { id, username, name, role, active, password } = draft;
    const storeId = draft.storeId || null;
    busy = true;
    error =
      (await attempt(() => {
        if (!id) return api.createUser({ username, name, role, storeId, password });
        const patch: UserPatch = { name, role, storeId, active };
        if (password) patch.password = password;
        return api.patchUser(id, patch);
      })) ?? '';
    busy = false;
    if (!error) {
      message = 'Usuario guardado.';
      draft = null;
    }
    await reload();
  }
</script>

<div class="split">
  <section>
    <div class="row">
      <h3>Usuarios</h3>
      <span class="spacer"></span>
      <button class="primary" onclick={() => open(null)}>Nuevo usuario</button>
    </div>
    <table>
      <thead>
        <tr><th>Usuario</th><th class="optional">Nombre</th><th>Rol</th><th>Tienda</th><th></th></tr>
      </thead>
      <tbody>
        {#each users as u (u.id)}
          <tr class:voided={!u.active} class:selected={draft?.id === u.id} onclick={() => open(u)}>
            <td>{u.username}</td>
            <td class="optional">{u.name}</td>
            <td>{u.role === 'admin' ? 'Administrador' : 'Cajero'}</td>
            <td>{storeName(u.storeId)}</td>
            <td>{u.active ? '' : 'Inactivo'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <section class="detail" class:open={draft !== null}>
    <button class="back" onclick={() => (draft = null)}>‹ Volver</button>
    {#if message}<p class="muted">{message}</p>{/if}
    {#if draft}
      <form class="card" onsubmit={save}>
        <h3>{draft.id ? `Editar ${draft.username}` : 'Nuevo usuario'}</h3>
        {#if !draft.id}
          <label>
            Usuario
            <input bind:value={draft.username} required pattern="[A-Za-z0-9._\-]{'{2,40}'}" autocomplete="off" title="Letras, números, punto, guion" />
          </label>
        {/if}
        <label>Nombre <input bind:value={draft.name} required maxlength="120" /></label>
        <label>
          Rol
          <select bind:value={draft.role}>
            <option value="cashier">Cajero</option>
            <option value="admin">Administrador</option>
          </select>
        </label>
        <label>
          Tienda
          <select bind:value={draft.storeId} disabled={!isOrgAdmin()}>
            {#if isOrgAdmin()}<option value="">Todas las tiendas</option>{/if}
            {#each panel.stores as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
          </select>
        </label>
        <label>
          {draft.id ? 'Nueva contraseña (vacío: no cambiar)' : 'Contraseña'}
          <input bind:value={draft.password} type="password" required={!draft.id} minlength={draft.role === 'admin' ? ADMIN_PASSWORD_MIN : 4} autocomplete="new-password" />
        </label>
        <p class="muted">
          {draft.role === 'admin'
            ? `Los administradores pueden entrar a este panel: mínimo ${ADMIN_PASSWORD_MIN} caracteres.`
            : 'Los cajeros solo ingresan en las cajas: mínimo 4 caracteres.'}
        </p>
        {#if draft.id}
          <label class="check"><input type="checkbox" bind:checked={draft.active} /> Activo (puede ingresar)</label>
        {/if}
        <div class="row">
          <button type="button" onclick={() => (draft = null)}>Cancelar</button>
          <button class="primary" disabled={busy}>Guardar</button>
        </div>
        {#if error}<p class="error">{error}</p>{/if}
      </form>
    {:else}
      {#if error}<p class="error">{error}</p>{/if}
      <p class="muted">
        Selecciona un usuario para editarlo o cambiar su contraseña. Las cajas reciben los cambios en su
        siguiente sincronización.
      </p>
    {/if}
  </section>
</div>
