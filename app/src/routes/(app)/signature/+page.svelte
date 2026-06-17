<script lang="ts">
  import type { User } from '$lib/types';
  export let data: { user: User };
  let user: User;
  $: ({ user } = data);

  import { signature } from "$lib/signature";
  import GoBack from "~icons/mdi/arrow-left";
  import { tooltip } from "$lib/actions";

  let html = get(signature);

  import { onMount } from "svelte";

  onMount(() => {
    setTimeout(() => {
      html = get(signature);
    }, 1);
  })

  // Explicit save / cancel — editing no longer auto-saves. The old behaviour only
  // persisted as a side effect of navigating away (the back button), which read as
  // "saves on back". bind:html keeps `html` current as you type.
  const save = action(async () => {
    await _put("/api/signature", { html });
    signature.set(html);
    _message($locale.notifier.Signature_saved);
    goto("/me");
  })

  const cancel = () => goto("/me");

  import { _message } from "$lib/Notify/notify";
  import { locale } from "$lib/locale";
  import TransitionPage from '$lib/TransitionPage.svelte';
  import SignatureEditor from '$lib/Editor/SignatureEditor.svelte';
  import AccountHeader from "$lib/Dashboard/AccountHeader.svelte";
  import Ripple from "$lib/Ripple.svelte";
  import { get } from "svelte/store";
  import { action, _put } from "$lib/util";
  import { goto } from "$app/navigation";
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
    padding-bottom: 3rem;
  }

  .editor {
    background: #fff;
    min-height: 20rem;
    display: flex;
    flex-direction: column;
  }

  .actions {
    display: flex;
    flex-direction: row;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-top: 1.25rem;
  }

  .back {
    align-self: flex-start;
    margin: 0.75rem 0.75rem -1rem;
    width: 2.5rem;
    height: 2.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    border-radius: 50%;
    flex: none;
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
        <SignatureEditor bind:html />
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
