<script lang="ts" context="module">
  export type MailboxContext = {
    next: () => Promise<void>,
    prev: () => Promise<void>,
  };
</script>

<script lang="ts">
  export let mailbox: Mailbox;
  export let messages: Messages;
  export let selection: TMessage[] = [];
  // Unified views point this at /api/unified/...; real mailboxes leave it null.
  export let listBase: string | null = null;
  let scrolled = false;

  import type { Mailbox, Messages, Message as TMessage } from "$lib/types";
  import { add, tooltip } from "$lib/actions";
  import { Counters, Exists, Expunge } from "$lib/events";

  import { onMount, setContext } from "svelte";
  import Message from "./Message.svelte";
  import Top from "./Top.svelte";
      
  let loadingMore = false;

  // Every listing request carries the active direction filter, so paging and the count
  // come back describing the filtered set rather than being trimmed afterwards.
  const listUrl = (params: string[] = []) => {
    const all = [...params, directionParam(active)].filter(Boolean);
    const base = listBase ?? `/api/mailboxes/${mailbox.id}/messages`;
    return `${base}${all.length ? "?" + all.join("&") : ""}`;
  }

  // Every listing request belongs to a generation, and changing the filter supersedes
  // whatever is in flight. Without that, a "load more" started under the old filter
  // lands after the new list is installed and appends its rows — and its cursor — into
  // it, and two quick chip toggles can finish out of order and leave the older answer on
  // screen. A superseded response is dropped rather than merged.
  let listGeneration = 0;

  const next = action(async () => {
    if(!messages.nextCursor) return;
    const generation = listGeneration;
    loadingMore = true;
    try {
      const json: Messages = await _get(listUrl([`next=${messages.nextCursor}`, "limit=50"]))
      if(generation !== listGeneration) return;
      const grown = dedup([ ...messages.results, ...json.results ]);
      messages = {
        ...messages,
        // Unified pages re-sort on append: the server serves what answered when one
        // account's upstream fails, so a newer row can arrive a round late.
        results: unified ? sortUnified(grown) : grown,
        nextCursor: json.nextCursor,
        total: json.total ?? messages.total,
      }
    } finally {
      loadingMore = false;
    }
  })

  // Switching the filter is not a refresh of the same list — it is a different list, so
  // it replaces rather than reconciles. reconcileFirstPage exists to decide what to keep
  // from what is already on screen; here the answer is nothing, and running it would
  // hold on to rows the new filter excludes.
  // Unified views: many source mailboxes behind one synthetic one. Rows carry
  // their real mailbox; SSE events match against the id SET, and refetches
  // replace rather than reconcile (uid-window reasoning is single-mailbox).
  $: unified = isUnifiedMailbox(mailbox);
  $: liveSet = mailbox.id === UNIFIED_IDS.inbox ? $inboxIds : mailbox.id === UNIFIED_IDS.sent ? $sentIds : null;

  $: active = activeDirection(mailbox, $direction);
  // Starts as null, not as the stored value: the page was loaded unfiltered, so a
  // filter carried over from an earlier session has to be applied once on arrival too,
  // not only when the user touches a chip.
  let appliedDirection: ReturnType<typeof activeDirection> = null;
  $: if(active !== appliedDirection) applyDirection(active);

  // The last filter whose results actually reached the screen — the only thing that can
  // say what the list is showing.
  let renderedDirection: ReturnType<typeof activeDirection> = null;

  // The chip must never claim a filter the list is not showing. appliedDirection moves
  // first so this does not re-enter while the request is out; everything after settles it
  // against what was actually rendered.
  //
  // Deliberately NOT wrapped in action(): that reports a failure and swallows it, which
  // is right for a button and useless for deciding whether the filter took. The toolbar's
  // Reload goes through prev(), which refetches page one under the current filter and
  // leaves the generation alone — so reloadNow has exactly one caller, and this is it.
  let applyToken = 0;
  const applyDirection = async (value: ReturnType<typeof activeDirection>) => {
    const token = ++applyToken;
    appliedDirection = value;

    let failure: string | null = null;
    try {
      await reloadNow();
    } catch(e: any) {
      failure = e?.message ?? null;
    }

    // A newer apply has taken over the state; it will settle it on its own terms.
    if(token !== applyToken) return;

    // Resolving is not the same as having rendered. A request superseded by a manual
    // reload returns without throwing and without installing anything, so if that reload
    // then failed, treating this as success left the old rows under a lit chip with
    // nothing to retry. Whatever DID reach the screen is the truth, so the filter falls
    // back to it — which is also the right answer when this request simply failed.
    if(renderedDirection !== value) {
      appliedDirection = renderedDirection;
      direction.set(renderedDirection);
    }
    if(failure) _error(failure);
  }

  const reloadNow = async () => {
    const generation = ++listGeneration;
    const requested = active;
    const json: Messages = await _get(listUrl(["limit=50"]));
    if(generation !== listGeneration) return;
    // A unified page missing an account is not a shorter list, and installing it as one
    // erases every row that account had on screen — plus every older page already
    // loaded, since this path REPLACES rather than reconciles. Keep what is there and
    // say so: an explicit refresh must not look like a silent no-op.
    if(unified && json.partial) throw new Error($locale.errors?.request_failed ?? "Request failed");
    selection = [];
    messages = json;
    renderedDirection = requested;
  }

  const prev = action(async () => {
    const generation = listGeneration;
    const json: Messages = await _get(listUrl());
    if(generation !== listGeneration) return;
    if (unified) {
      // A page missing an account would blank every row it had; silent here, unlike
      // reloadNow, because this runs off an SSE event and nobody asked for it.
      if(json.partial) return;
      // reconcileFirstPage reasons in ONE mailbox's uid space and rows here come from
      // many, so the unified variant does the same job in the merge order instead.
      // Replacing outright — which is what this did — threw away every page the reader
      // had loaded below the first, on any new message in any of the mailboxes.
      const merged = reconcileUnifiedFirstPage(messages, json);
      // Keyed by (mailbox, uid): uids collide across accounts. Same reasoning as the
      // single-mailbox path below — rebuild FROM the fresh objects, or the toolbar's
      // optimistic writes land on rows nobody renders.
      const selectedKeys = new Set(selection.map(rowKey));
      selection = merged.results.filter(m => selectedKeys.has(rowKey(m)));
      messages = { ...messages, results: merged.results, nextCursor: merged.nextCursor, total: json.total ?? messages.total };
      return;
    }
    // See reconcile.ts for why the next cursor decides the fate of rows below the
    // refetched page — that is what finally retires an orphaned autosaved draft.
    const { results, nextCursor } = reconcileFirstPage(messages, json);
    // Rebuild the selection FROM `results`, not by filtering the old array.
    //
    // Two things depend on this. Dropping rows the refetch no longer returns (the
    // orphan-draft case) stops the toolbar acting on a message that is gone. But the
    // refetched page is made of BRAND NEW objects, so filtering in place would keep the
    // survivors as the previous ones — and the toolbar mutates what is in `selection`
    // (Top.markAsSeen does `item.seen = v`, then re-renders from `messages.results`).
    // Those writes would land on objects nobody renders: the server goes read, the
    // toolbar flips to "Mark as not seen", and the row stays looking unread. Selecting
    // the same objects the list renders is what makes the optimistic update visible.
    // The search list had the identical defect; this is the same fix.
    const selectedIds = new Set(selection.map(m => m.id));
    selection = results.filter(m => selectedIds.has(m.id));
    // Adopt the refetched count too: while a filter is on this is the number the toolbar
    // shows, and it describes the filtered set, which nothing else keeps up to date.
    messages = { ...messages, results, nextCursor, total: json.total ?? messages.total }
  })

  const context: MailboxContext = { next, prev };
  setContext("mailbox", context);

  const scroll = (node: HTMLElement) => {
    return {
      destroy: add(node, "scroll", () => {
        scrolled = node.scrollTop !== 0;
      }, { passive: true })
    }
  }

  onMount(() => Counters.on(event => {
    if(event.mailbox === mailbox.id) {
      mailbox.unseen = event.unseen;
      mailbox.total = event.total;
    }
  }))

  import Plus from "~icons/mdi/plus";
  import Ripple from "$lib/Ripple.svelte";
  import { action, _get } from "$lib/util";
  import CircularProgress from "$lib/CircularProgress.svelte";
  import { dedupById, reconcileFirstPage, reconcileUnifiedFirstPage, rowKey } from "./reconcile";
  import { activeDirection, direction, directionParam } from "$lib/direction";
  import { UNIFIED_IDS, inboxIds, isUnifiedMailbox, sentIds, sortUnified } from "$lib/unified";
  import { _error } from "$lib/Notify/notify";

  const dedup = dedupById;

  onMount(() => {
    
    let timer: any;
    let timer2: any;
    let timer3: any;
    let rids: string[] = []
    
    const removeIds = () => {
      if(messages.results.some(item => rids.includes(rowKey(item)))) {
        const results = messages.results.filter(item => !rids.includes(rowKey(item)));
        messages = {
          ...messages,
          results,
          total: Math.max(0, messages.total - (messages.results.length - results.length)),
        };

        selection = selection.filter(item => !rids.includes(rowKey(item)))
      } else if(active) {
        // The expunged message was not among the loaded rows, so nothing local can
        // account for it — and while a filter is on, the folder counter the SSE event
        // carries is not the number being displayed. The event says nothing about
        // direction either, so whether it belonged to this filter can only be answered
        // by asking: refetch page one, which brings a fresh filtered total with it.
        clearTimeout(timer);
        timer = setTimeout(prev, 500);
      }
      if(messages.results.length < 15) {
        clearTimeout(timer3);
        timer3 = setTimeout(next, 500);
      }
      rids = [];
    }

    const off = [
      
      Exists.on(event => {
        if(event.mailbox === mailbox.id || liveSet?.has(event.mailbox)) {
          clearTimeout(timer);
          timer = setTimeout(prev, 500);
        } 
      }),

      Expunge.on(event => {
        if((event.mailbox === mailbox.id || liveSet?.has(event.mailbox)) && event.uid != null) {
          rids.push(`${event.mailbox}:${event.uid}`);
          clearTimeout(timer2);
          timer2 = setTimeout(removeIds, 250)
        }
      }) 
    ]
    
    return () => {
      clearTimeout(timer);
      clearTimeout(timer2);
      clearTimeout(timer3);
      runAll(off);
    }
  })

  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";
import { locale } from "$lib/locale";

  const runAll = (handlers: Array<() => void>) => {
    for (const handler of handlers) {
      handler();
    }
  };

  const customSlide = (node: HTMLElement, { delay = 0, duration = 400, easing = cubicOut } = {}) => {
    const height = node.getBoundingClientRect().height;
    return {
        delay,
        duration,
        easing,
        css: (t: number, u: number) =>
            'box-sizing: border-box;' +
            'overflow: hidden;' +
            `opacity: ${t};` +
            `height: ${t * height}px;`
    }
  }
</script>

<style>
  .mailbox {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .content {
    flex: 1;
    overflow-x: hidden;
    overflow-y: auto;
    padding-bottom: 6rem;
  }
  
  .empty {
    flex: none;
    margin: var(--space-12) auto;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    color: var(--text-muted);
    font-size: 1rem;
  }

  .next-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .next {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--red);
    font-size: 2rem;
    border-radius: var(--radius-full); 
    padding: var(--space-4);
    margin-top: var(--space-2);
  }

  .loading-more{
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2rem;
    border-radius: var(--radius-full); 
    padding: var(--space-4);
    margin-top: var(--space-2);
  }
</style>

<div class="mailbox">
  <Top {mailbox} bind:messages bind:selection bind:loadingMore {scrolled} />
  <div class="content" use:scroll in:fly={{ duration: 150, y: -15 }}>
    {#if messages.results.length || loadingMore}
      <div class="messages" transition:customSlide|local={{ duration: 250 }}>
        {#each messages.results as message (rowKey(message))}
          <div class="message" transition:customSlide|local={{ duration: 250 }}>
            <!-- `message` is deliberately NOT bound. The each is keyed by
                 `message.id`, i.e. the key is derived from the very value a
                 `bind:` would write back. When a new message arrives and the
                 list is rebuilt, that write-back lands in a reused block and
                 overwrites the row that was already there with the incoming
                 message — two rows then render the SAME message (and the same
                 id, so ticking one checkbox ticks both). The initial render is
                 fine; only live updates corrupt, which is why it only showed up
                 after a message arrived and vanished on refresh. Message only
                 ever mutates `message.flagged` in place on the shared object,
                 so one-way is enough. -->
            <Message {message} {mailbox} bind:selection />
          </div>
        {/each}
      </div>
      <div class="next-wrap">
        {#if loadingMore}
          <div class="loading-more">
            <CircularProgress />
          </div>
        {:else if messages.nextCursor}
          <div class="next btn-dark" on:click={next}>
            <Plus />
            <Ripple />
          </div>
        {/if}
      </div>
    {:else}
      <div class="empty-wrap" in:customSlide|local={{duration: 250}}>
        <div class="empty">
          {$locale.This_mailbox_is_empty}
        </div>
      </div>
    {/if}
  </div>
</div>
