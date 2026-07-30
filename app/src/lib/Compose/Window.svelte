<script lang="ts">
  export let current: Draft;
  export let onMinimize: () => void;
  export let onRemove: () => void;
  let iframe: HTMLIFrameElement;
  let cc: HTMLInputElement;
  let bcc: HTMLInputElement;

  // Each flag watches its OWN field. They were crossed, so a draft opened with
  // recipients in Cc showed an empty Bcc box instead and hid the populated Cc one —
  // the addresses were still there and still sent, just not on screen.
  $: showCc = current?.[kShowCc] || current?.cc?.length;
  $: showBcc = current?.[kShowBcc] || current?.bcc?.length;

  import { kSent, save } from "./compose";
  import { crossin, crossout } from "./compose";
  import type { Draft } from "./compose";
  
  import { onMount } from "svelte";
  import { add } from "$lib/actions";
  import Editor from "$lib/Editor/Editor.svelte";
  import AddrInput from "./AddrInput.svelte";
  import { accounts, tabAccount } from "$lib/account";
  import { _get } from "$lib/util";
 
  // From = the account whose Drafts this draft lives in. Switching retargets
  // draft.mailbox to the chosen account's Drafts and lets the immutable-save
  // machinery migrate it (create in the new home, retire from the old — kSavedIn).
  // Locked once a reference exists (replies cannot cross accounts: WildDuck
  // resolves the reference within one user) or once files were uploaded (they live
  // in the first account's storage).
  $: fromLocked = !!current?.reference || (current?.files?.length ?? 0) > 0;
  $: fromId = current?.accountId ?? $tabAccount;
  $: fromChoices = $accounts.filter(a => !a.needsReauth);

  const switchFrom = async (accId: string) => {
    if (!current || fromLocked || accId === fromId) return;
    const boxes = await _get(`/api/mailboxes?account=${encodeURIComponent(accId)}`).catch(() => null);
    const drafts = boxes?.results?.find((b: { specialUse?: string }) => b.specialUse === "\\Drafts");
    if (!drafts) return;
    current.accountId = accId;
    current.mailbox = drafts.id;
    current = current; // the autosave sees the change and migrates the draft
  };

  let prev = clone(current);
  let timer: any;
  let token = 1;
  let saved = true;
  // Compose nulls `current` when the window is minimized or closed, and it does so
  // BEFORE this component unmounts — so the teardown save at the bottom read null and
  // bailed, silently losing everything typed since the last autosave. The guards there
  // still have to stay (a null read throws inside the flush and freezes the scheduler),
  // so hold on to the last real draft and save THAT on the way out.
  let lastDraft: Draft = current;
  $: if(current) lastDraft = current;
  $: onCurrent(current);
  const onCurrent = (current: Draft) => {
    // Same teardown race as dosave(): a null current here would make
    // isDraftEquals destructure null and throw — which breaks the Svelte flush
    // and leaves the draft state stale (lost recipients/subject/files until a
    // page refresh). Bail out cleanly instead.
    if(!current || isDraftEquals(prev, current)) return;
    prev = clone(current);
    saved = false;
    const t = ++token;
    clearTimeout(timer);
    timer = setTimeout(() => { void dosave(current, t).catch(reportSaveFailure); }, 1500);
  }

  // Ordering of the saves themselves is guaranteed by save() in compose.ts, which
  // serializes per draft — it has to be there rather than here, because send() calls
  // save() directly and would otherwise race an autosave still in flight.
  //
  // This queue stays for a narrower reason: it keeps the kSent / teardown check next to
  // the call it guards. The debounce timer only cancels the NEXT scheduled save, never
  // one already running, so without it a save slower than the 1500ms debounce would let
  // the following one skip its check entirely.
  let queue: Promise<unknown> = Promise.resolve();

  // `saved` stays false when a save fails, so the unsaved-changes dot remains on
  // screen and the next edit retries — that is the user-facing signal. This only
  // stops the rejection escaping as an unhandled promise, which it did at both call
  // sites because neither awaited the returned chain.
  const reportSaveFailure = (e: unknown) => {
    console.warn("[raven] draft save failed; changes are still unsaved", e);
  };

  const dosave = (current: Draft, t: number): Promise<void> => {
    queue = queue.catch(() => {}).then(async () => {
      // Checked HERE, at execution time rather than enqueue time: current can be null
      // if the compose window was torn down while we waited (navigating away mid-edit),
      // and send() may have claimed the draft via kSent in the meantime — saving after
      // that would resurrect a draft for a message already on its way out.
      if(!current || current[kSent]) return;
      const newId = await save(current);
      // here we dont trigger an invalidate
      current.id = newId;
      if(t === token) {
        saved = true;
      }
    });
    return queue as Promise<void>;
  }

  const isDraftEquals = (src: Draft, target: Draft): boolean => {
    const { id: id1, key: key1, ...item1 } = src;
    const { id: id2, key: key2, ...item2 } = target;
    return equals(item1, item2);
  }


  onMount(() => {
         
    const keydown = (event: KeyboardEvent) => { 
      if(event.key === "Escape") onMinimize();
    }

    const off = [
      add(document, "keydown", keydown, { capture: true }),
    ]

    if(iframe && iframe.contentDocument) {
      off.push(add(iframe.contentDocument, "keydown", keydown, { capture: true }));
    }

    return () => {
      if(!saved) void dosave(lastDraft, ++token).catch(reportSaveFailure);
      clearTimeout(timer);
      runAll(off);
    }
  })

  import Ripple from "$lib/Ripple.svelte";
  import Close from "~icons/mdi/close";
  import Minimize from "~icons/mdi/color-helper";
  import NotSaved from "~icons/mdi/circle-small";
  import { kShowBcc, kShowCc } from "./compose";
  import { clone, equals } from "$lib/util";
import { locale } from "$lib/locale";

  const runAll = (handlers: Array<() => void>) => {
    for (const handler of handlers) {
      handler();
    }
  };

  const savingSlide = (node: HTMLElement, options: {} = {}) => {
    const style = getComputedStyle(node);
    const width = parseInt(style.width) + parseFloat(style.marginInlineEnd); + parseFloat(style.marginInlineStart);
    return {
      css: (t: number, u: number) => {
        return `margin-inline-start: -${u * width}px; transform: scale(${t});`;
      },
      duration: 100
    }
  }
</script>

<style>

.window {
    position: fixed;
    width: 90%;
    height: 87.5%;
    top: 5%;
    left: 5%;
    background: var(--surface);
    color: var(--text);
    border-radius: var(--radius-md);
    z-index: calc(var(--z-compose) + 2);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: rgba(0,0,0,0.5) 0 2px 8px 2px;
    overflow: hidden;
  }

  .window-top {
    height: 2.5rem;
    display: flex;
    flex: none;
    box-sizing: border-box;
    align-items: center;
    justify-content: flex-end;
    background: #333; /* intentional dark compose chrome (white text), like the navbar */
    cursor: pointer;
  }

  .window-title {
    color: #ddd; /* light title on the dark compose chrome */
    font-size: 0.9rem;
    margin-inline-end: auto;
    margin-inline-start: var(--space-4);
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  .saving {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .saving-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2rem;
    margin-inline-start: calc(-1 * var(--space-3));
  }

  .window-btn {
    display: flex;
    padding: 0;
    align-items: center;
    justify-content: center;
    font-size: 1.25rem;
    width: 2.25rem;
    height: 2.25rem;
    margin: 0.125rem;
    border-radius: var(--radius-sm);
    color: #fff;
  }

  .window-minimize {
    font-size: 0.75rem;
  }

  .window-contents {
    display: flex;
    flex: 1;
    flex-direction: column;
  }

  x-metadata {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }

  x-metadata {
    display: flex;
    flex: none;
    flex-direction: column;
  }

  .label-input {
    position: relative;
    border-bottom: var(--border) 1px solid;
    display: flex;
    flex-direction: row;
    flex: none;
    min-height: 2em;
    align-items: center;
    padding: 0.25em 0.5em;
    margin: 0 0.5em;
    cursor: text;
  }

  x-label {
    font-size: 0.9rem;
    color: var(--text-muted);
    align-self: flex-start;
    line-height: 2.5rem;
    height: 2.25rem;
    cursor: default;
    user-select: none;
  }

  .from-select {
    background: transparent;
    border: none;
    color: var(--text);
    font: inherit;
    padding: 0;
    outline: none;
    cursor: pointer;
  }

  .from-select:disabled {
    color: var(--text-muted);
    cursor: default;
  }

  .from-select option {
    background: var(--surface);
    color: var(--text);
  }

  .subject {
    font-size: 0.9rem;
    padding: 0 0.5em;
    height: 100%;
    border: 0;
    margin: 0;
    outline: 0;
    flex: 1;
    font-size: inherit;
    font-family: inherit;
    /* Inherit the dark compose chrome rather than the <input> UA white/black. */
    background: transparent;
    color: inherit;
  }

  x-toggle-cc {
    position: absolute;
    right: 0;
    top: 0;
    display: flex;
    flex-direction: row;
    align-items: center;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--surface);
    font-size: 0.9rem;
    height: 2.75rem;
  }

  x-toggle-cc > span {
    height: 100%;
    display: flex;
    box-sizing: border-box;
    user-select: none;
    align-items: center;
    justify-content: center;
    padding: 0.25em;
    cursor: pointer;
    color: var(--text-muted);
  }

  x-toggle-cc > span:hover {
    text-decoration: underline;
  }
</style>

<div class="window" in:crossin={{key: current}} out:crossout={{key: current}}>
  <div class="window-top" on:click={onMinimize} on:auxclick={() => onRemove()}>
    <div class="window-title">
      <div class="saving">
        {#if !saved}
          <div class="saving-icon" transition:savingSlide|local>
            <NotSaved />
          </div>
        {/if}
      </div>
      {$locale.New_message}
    </div>
    <div class="btn-light window-btn window-minimize" on:click|stopPropagation={onMinimize}>
      <Minimize />
      <Ripple />
    </div>
    <div class="window-btn window-close btn-light" on:click|stopPropagation={onRemove}>
      <Close />
      <Ripple />
    </div>
  </div>
  <div class="window-contents">
    <x-metadata>
      {#if fromChoices.length > 1}
        <label class="label-input from-row">
          <x-label>{$locale["From:"]}</x-label>
          <select class="from-select" disabled={fromLocked} title={fromLocked ? $locale.From_locked : null}
            value={fromId} on:change={(e) => switchFrom(e.currentTarget.value)}>
            {#each fromChoices as acc (acc.id)}
              <option value={acc.id}>{acc.username}</option>
            {/each}
          </select>
        </label>
      {/if}

      <label class="label-input" for="compose-to">
        <x-label>{$locale["To:"]}</x-label>
        <AddrInput id="compose-to" name="to" bind:addrs={current.to} />
        <x-toggle-cc>
          {#if !showCc}
            <span on:click|preventDefault={() => {
              current[kShowCc] = true;
              setTimeout(() => cc && cc.focus(), 5)
            }}>{$locale.Cc}</span>
          {/if}
          {#if !showBcc}
            <span on:click|preventDefault={() => {
                current[kShowBcc] = true;
                setTimeout(() => bcc && bcc.focus(), 5);
            }}>{$locale.Bcc}</span>
          {/if}
        </x-toggle-cc>
      </label>
      {#if showCc}
        <label class="label-input" for="compose-cc">
          <x-label>{$locale["Cc:"]}</x-label>
          <AddrInput id="compose-cc" name="cc" bind:addrs={current.cc} bind:input={cc} />
        </label>  
      {/if}
      {#if showBcc}
        <label class="label-input" for="compose-bcc">
          <x-label>{$locale["Bcc:"]}</x-label>
          <AddrInput id="compose-bcc" name="bcc" bind:addrs={current.bcc} bind:input={bcc} />
        </label>  
      {/if}
      <label class="label-input" for="compose-subject">
        <x-label>{$locale["Subject:"]}</x-label>
        <input type="text" name="subject" id="compose-subject" class="subject" autocomplete="off" bind:value={current.subject}>
      </label>
    </x-metadata>
    <Editor bind:draft={current} bind:iframe {onRemove} />
  </div>
</div>
