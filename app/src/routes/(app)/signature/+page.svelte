<script lang="ts">
  import type { User } from '$lib/types';
  export let data: { user: User };
  let user: User;
  $: ({ user } = data);

  import { signature } from "$lib/signature";
  import GoBack from "~icons/mdi/arrow-left";
  import { tooltip } from "$lib/actions";
  import { onMount } from "svelte";

  let html = get(signature);

  // "Dirty" = the user actually edited the signature. The editor's `input` event
  // signals real edits (typing / paste / toolbar); comparing HTML would
  // false-positive on the load-time sanitisation/normalisation. We confirm before
  // leaving with unsaved edits instead of silently saving (or silently losing them).
  let touched = false;
  let confirmOpen = false;
  let bypass = false;
  let pendingUrl: string | null = null;

  const persist = async () => {
    await _put("/api/signature", { html });
    signature.set(html);
    touched = false;
    _message($locale.notifier.Signature_saved);
  };

  const save = action(async () => {
    await persist();
    goto("/me");
  });

  const cancel = () => goto("/me");

  const stay = () => { confirmOpen = false; pendingUrl = null; };

  const discardAndLeave = () => {
    bypass = true;
    confirmOpen = false;
    goto(pendingUrl ?? "/me");
  };

  const saveAndLeave = action(async () => {
    await persist();
    bypass = true;
    confirmOpen = false;
    goto(pendingUrl ?? "/me");
  });

  // Back / Cancel / navbar / browser back — intercept and confirm when there are
  // unsaved edits. Save and the dialog's own actions set `bypass` to pass through.
  beforeNavigate((nav) => {
    if (bypass || !touched) return;
    if (nav.willUnload) return; // tab close / refresh -> beforeunload below
    nav.cancel();
    pendingUrl = nav.to?.url.href ?? "/me";
    confirmOpen = true;
  });

  onMount(() => {
    // Re-read once the layout's onMount has populated the signature store.
    setTimeout(() => { html = get(signature); }, 1);

    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (touched) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  });

  import { _message } from "$lib/Notify/notify";
  import { locale } from "$lib/locale";
  import TransitionPage from '$lib/TransitionPage.svelte';
  import SignatureEditor from '$lib/Editor/SignatureEditor.svelte';
  import AccountHeader from "$lib/Dashboard/AccountHeader.svelte";
  import Ripple from "$lib/Ripple.svelte";
  import Dialog from "$lib/Dialog.svelte";
  import { get } from "svelte/store";
  import { action, _put } from "$lib/util";
  import { beforeNavigate, goto } from "$app/navigation";
</script>

<style>
  .account {
    flex-direction: column;
    --spacing: 1.5rem;
    background: rgba(0, 0, 0, 0.025);
    overflow-x: hidden;
    overflow-y: auto;
    height: 100%;
  }

  .page {
    padding-inline: var(--spacing);
    padding-bottom: var(--space-12);
  }

  .editor {
    background: var(--surface);
    min-height: 20rem;
    display: flex;
    flex-direction: column;
  }

  .actions {
    display: flex;
    flex-direction: row;
    justify-content: flex-end;
    gap: var(--space-3);
    margin-top: var(--space-5);
  }

  .back {
    align-self: flex-start;
    margin: var(--space-3) var(--space-3) calc(-1 * var(--space-4));
    width: 2.5rem;
    height: 2.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    border-radius: var(--radius-full);
    flex: none;
  }

  .confirm {
    display: flex;
    flex-direction: column;
  }

  .confirm-text {
    margin-bottom: var(--space-6);
    line-height: 1.5;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
  }
</style>

<svelte:head>
  <title>{$locale.My_account}</title>
</svelte:head>

<TransitionPage>
  <div class="account">
    <a class="back na btn-dark" href="/me" use:tooltip={$locale.My_account}>
      <GoBack />
    </a>

    <AccountHeader {user} />

    <div class="page">
      <h1>{$locale.Edit_your_signature}</h1>

      <div class="editor elev3">
        <SignatureEditor bind:html onDirty={() => touched = true} />
      </div>

      <div class="actions">
        <button class="btn-light" on:click={cancel}>
          {$locale.Cancel}
          <Ripple />
        </button>
        <button class="btn-light btn-primary elev2" on:click={save}>
          {$locale.Save}
          <Ripple />
        </button>
      </div>
    </div>
  </div>
</TransitionPage>

{#if confirmOpen}
  <Dialog title={$locale.Unsaved_changes} width="480px" onClose={stay}>
    <div class="confirm">
      <div class="confirm-text">{$locale.Unsaved_changes_body}</div>
      <div class="confirm-actions">
        <button class="btn-light" on:click={discardAndLeave}>
          {$locale.Discard}
          <Ripple />
        </button>
        <button class="btn-light btn-primary elev2" on:click={saveAndLeave}>
          {$locale.Save}
          <Ripple />
        </button>
      </div>
    </div>
  </Dialog>
{/if}
