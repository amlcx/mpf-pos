<script lang="ts">
  import { ToggleGroup } from 'bits-ui';
  import { type CashCount, type CashMovement, countCents, formatCents, parseCents } from '@mpf/shared';
  import { app, closeCashDrawer, moveDrawerCash, openCashDrawer } from '../lib/state.svelte.ts';
  import CashCountForm from './CashCount.svelte';

  const symbol = $derived(app.context?.store.currencySymbol ?? '');
  const money = (cents: number) => formatCents(cents, symbol);
  const time = (iso: string) => new Date(iso).toLocaleTimeString('es-CO', { timeStyle: 'short' });
  const day = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('es-CO', { dateStyle: 'full' });
  const who = (id: string) => app.people[id] ?? 'Alguien';

  let busy = $state(false);
  let error = $state('');

  // ------------------------------------------------------------ opening
  let openingCount = $state<CashCount>({});
  async function open() {
    busy = true;
    error = (await openCashDrawer($state.snapshot(openingCount))) ?? '';
    busy = false;
    if (!error) openingCount = {};
  }

  // ----------------------------------------------------------- movements
  let kind = $state<CashMovement['kind']>('out');
  let amount = $state('');
  let reason = $state('');
  async function move(event: SubmitEvent) {
    event.preventDefault();
    const cents = parseCents(amount);
    if (cents === null || cents <= 0) return void (error = 'Escribe el valor como 12.000 o 12000.');
    busy = true;
    error = (await moveDrawerCash(kind, cents, reason)) ?? '';
    busy = false;
    if (!error) {
      amount = '';
      reason = '';
    }
  }

  // ------------------------------------------------------------- closing
  // Blind: the cashier counts first; only then does the register say what it
  // expected. A difference needs a note before the drawer closes.
  let closing = $state(false);
  let closingCount = $state<CashCount>({});
  let difference = $state<{ expectedCents: number; countedCents: number } | null>(null);
  let note = $state('');
  /** The drawer just closed, shown until the cashier moves on. */
  let closed = $state<{ expectedCents: number; countedCents: number; note: string } | null>(null);

  async function close(withNote: boolean) {
    busy = true;
    error = '';
    const result = await closeCashDrawer($state.snapshot(closingCount), withNote ? note : '');
    busy = false;
    if (result.ok) {
      closed = { expectedCents: result.expectedCents, countedCents: result.countedCents, note: withNote ? note.trim() : '' };
      closing = false;
      closingCount = {};
      difference = null;
      note = '';
    } else if (result.reason === 'note_required') {
      difference = { expectedCents: result.expectedCents, countedCents: result.countedCents };
    } else if (result.reason === 'unsynced_sales') {
      error = 'Una venta todavía espera respuesta del servidor. Espera un momento y vuelve a intentarlo.';
    } else {
      error = 'La caja ya está cerrada.';
    }
  }

  function recount() {
    difference = null;
    note = '';
  }

  const diffLabel = (d: { expectedCents: number; countedCents: number }) => {
    const diff = d.countedCents - d.expectedCents;
    return diff === 0 ? 'Cuadra' : diff > 0 ? `Sobran ${money(diff)}` : `Faltan ${money(-diff)}`;
  };

  const drawer = $derived(app.drawer.state === 'closed' ? null : app.drawer.drawer);
  const moved = (k: CashMovement['kind']) =>
    (drawer?.movements ?? []).filter((m) => m.kind === k).reduce((sum, m) => sum + m.amountCents, 0);
</script>

{#if closed}
  <div class="centered">
    <div class="card">
      <h2>Caja cerrada</h2>
      <p class="sum"><span>Contado</span><strong>{money(closed.countedCents)}</strong></p>
      <p class="sum"><span>Esperado</span><strong>{money(closed.expectedCents)}</strong></p>
      <p class="sum {closed.countedCents === closed.expectedCents ? 'good' : 'bad'}">
        <span>Resultado</span><strong>{diffLabel(closed)}</strong>
      </p>
      {#if closed.note}<p class="muted">Nota: {closed.note}</p>{/if}
      <button class="primary" onclick={() => (closed = null)}>Listo</button>
    </div>
  </div>
{:else if app.drawer.state === 'closed'}
  <div class="centered">
    <div class="card wide">
      <h2>Apertura de caja</h2>
      <p class="muted">Cuenta el dinero con el que empiezas y escribe cuántos hay de cada billete y moneda.</p>
      <CashCountForm bind:count={openingCount} {symbol} />
      {#if error}<p class="error">{error}</p>{/if}
      <button class="primary" disabled={busy} onclick={open}>
        Confirmo que conté {money(countCents(openingCount))} y abro la caja
      </button>
      <p class="muted hand">La apertura queda a nombre de {app.session?.user.name}.</p>
    </div>
  </div>
{:else if closing || app.drawer.state === 'stale'}
  <div class="centered">
    <div class="card wide">
      {#if app.drawer.state === 'stale' && drawer}
        <h2>Cierre pendiente</h2>
        <p class="muted">
          La caja del {day(drawer.businessDate)} sigue abierta. Ciérrala antes de abrir la de hoy: cuenta el dinero que
          quedó en el cajón.
        </p>
      {:else}
        <h2>Cierre de caja</h2>
        <p class="muted">Cuenta todo el dinero del cajón. El sistema te dice cuánto esperaba después de que cuentes.</p>
      {/if}

      {#if !difference}
        <CashCountForm bind:count={closingCount} {symbol} />
        {#if error}<p class="error">{error}</p>{/if}
        <div class="row">
          {#if app.drawer.state === 'open'}
            <button disabled={busy} onclick={() => { closing = false; closingCount = {}; error = ''; }}>Cancelar</button>
          {/if}
          <span class="spacer"></span>
          <button class="primary" disabled={busy} onclick={() => close(false)}>Terminé de contar</button>
        </div>
      {:else}
        <p class="sum"><span>Contado</span><strong>{money(difference.countedCents)}</strong></p>
        <p class="sum"><span>Esperado</span><strong>{money(difference.expectedCents)}</strong></p>
        <p class="sum bad"><span>Diferencia</span><strong>{diffLabel(difference)}</strong></p>
        <p class="muted">Vuelve a contar. Si la diferencia sigue, explica qué pasó para cerrar la caja.</p>
        <label>Nota <input bind:value={note} maxlength="300" placeholder="Ej.: devolví mal un cambio" /></label>
        {#if error}<p class="error">{error}</p>{/if}
        <div class="row">
          <button disabled={busy} onclick={recount}>Volver a contar</button>
          <span class="spacer"></span>
          <button class="primary" disabled={busy || !note.trim()} onclick={() => close(true)}>
            Cerrar con esta diferencia
          </button>
        </div>
      {/if}
    </div>
  </div>
{:else if drawer}
  <div class="split">
    <section>
      <h3>Entradas y salidas de efectivo</h3>
      <form class="row" onsubmit={move}>
        <ToggleGroup.Root type="single" class="row" aria-label="Tipo" bind:value={() => kind, (v) => { if (v) kind = v as CashMovement['kind']; }}>
          <ToggleGroup.Item value="out">Salida</ToggleGroup.Item>
          <ToggleGroup.Item value="in">Entrada</ToggleGroup.Item>
        </ToggleGroup.Root>
        <input bind:value={amount} inputmode="numeric" placeholder="Valor" aria-label="Valor" required />
        <input
          bind:value={reason}
          maxlength="300"
          placeholder={kind === 'out' ? 'Motivo (ej.: a la caja fuerte)' : 'Motivo (ej.: más sencillo)'}
          aria-label="Motivo"
          required
        />
        <button class="primary" disabled={busy}>Registrar</button>
      </form>
      {#if error}<p class="error">{error}</p>{/if}
      <table>
        <tbody>
          {#each [...drawer.movements].reverse() as m (m.id)}
            <tr>
              <td>{time(m.createdAt)}</td>
              <td>{m.kind === 'in' ? 'Entrada' : 'Salida'}</td>
              <td class="num">{m.kind === 'in' ? '+' : '−'}{money(m.amountCents)}</td>
              <td>{m.reason}</td>
              <td class="muted">{who(m.userId)}</td>
            </tr>
          {:else}
            <tr><td class="muted hand">Aún no hay entradas ni salidas.</td></tr>
          {/each}
        </tbody>
      </table>
    </section>

    <section class="detail">
      <h3>Caja abierta</h3>
      <p class="muted">Abierta por {who(drawer.openedBy)} a las {time(drawer.openedAt)}.</p>
      <p class="sum"><span>Base</span><strong>{money(drawer.openingCents)}</strong></p>
      <p class="sum"><span>Entradas</span><strong>{money(moved('in'))}</strong></p>
      <p class="sum"><span>Salidas</span><strong>{money(moved('out'))}</strong></p>
      {#if drawer.syncError}<p class="error">No se pudo enviar al servidor: {drawer.syncError}</p>{/if}
      <button class="primary" onclick={() => { closing = true; error = ''; }}>Cerrar caja</button>
      <p class="muted hand">Al final del día, después de todas las entradas y salidas.</p>
    </section>
  </div>
{/if}
