<script lang="ts">
  import type { DashContext } from "$lib/Dashboard/Dashboard.svelte";
  import type { Mailbox, Message } from "$lib/types";
  export let data: { query: string; results: Message[]; nextCursor: string | null; total: number };

  // Local, mutable copy of the loaded data. `SearchTop` / `SearchResult`
  // mutate `results` and `selection` through `bind:` (delete, move) and
  // `next()` appends paged results. Re-deriving these from `data` on every
  // reactive pass would re-run on each child mutation and overwrite the
  // optimistic change with the stale server value (deletions reappearing
  // until refresh). Only re-sync when SvelteKit delivers a fresh `data`
  // object (new query or an explicit refresh via `prev()`).
  let query = data.query;
  let results = data.results;
  let nextCursor = data.nextCursor;
  let total = data.total;
  let lastData = data;

  $: if (data !== lastData) {
    lastData = data;
    query = data.query;
    results = data.results;
    nextCursor = data.nextCursor;
    total = data.total;
    // Fresh results need not still contain everything that was selected: prev()
    // reloads after a delete or move, and a new query replaces the set outright.
    // Stale entries left in `selection` keep the toolbar in selection mode acting on
    // rows that are no longer on screen — and possibly on messages that no longer
    // exist. The mailbox list reconciles after its refetch for the same reason;
    // search never did. Identity here is (mailbox, id), matching the keyed each.
    const kept = new Set(results.map(m => `${m.mailbox}-${m.id}`));
    selection = selection.filter(m => kept.has(`${m.mailbox}-${m.id}`));
  }

  let selection: Message[] = [];
  let scrolled = false;

  import { getContext, setContext } from "svelte";
  const { mailboxes } = getContext("dash") as DashContext;

  const map = (mailboxes: Mailbox[]) => {
    const map = new Map<string, Mailbox>();
    for(const box of mailboxes) {
      map.set(box.id, box);
    }
    return map;
  }

  $: mailboxMap = map($mailboxes);

  import { add, tooltip } from "$lib/actions";
  
  const dedup = (messages: Message[]) => {
    const target: Message[] = [];
    for(const item of messages) {
      if(!target.some(m => m.mailbox === item.mailbox && m.id === item.id)) {
        target.push(item);
      }
    }
    return target;
  }

  let loadingMore = false;
  const next = action(async () => {
    if(!nextCursor) return;
    loadingMore = true;
    try {
      const json = await _get(`/api/search?next=${nextCursor}&limit=50`);
      results = dedup([...results, ...json.results]);
      nextCursor = json.nextCursor;
      loadingMore = false;
    } catch(e) {
      loadingMore = false;
      throw e;
    }
  })

  const prev = action(async () => {
    await goto(`/search?query=${encodeURIComponent(query)}&now=${Date.now()}`, { replaceState: true, keepFocus: true });
  });

  const context: MailboxContext = { next, prev };
  setContext("search", context);

  import Plus from "~icons/mdi/plus";
  import Ripple from "$lib/Ripple.svelte";
  import { action, _get } from "$lib/util";
  import CircularProgress from "$lib/CircularProgress.svelte";

  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";
  import SearchResult from "$lib/Search/SearchResult.svelte";
  import SearchTop from "$lib/Search/SearchTop.svelte";
  import { goto } from "$app/navigation";
  import type { MailboxContext } from "$lib/Mailbox/Mailbox.svelte";
import { locale } from "$lib/locale";

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

  const scroll = (node: HTMLElement) => {
    return {
      destroy: add(node, "scroll", () => {
        scrolled = node.scrollTop !== 0;
      }, { passive: true })
    }
  }
</script>

<svelte:head>
  <title>{query}</title>
</svelte:head>

<style>
  .search {
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

{#key query}
  <div class="search">
    <SearchTop bind:results bind:selection {scrolled} {total} {mailboxMap} />
    <div class="content" in:fly={{ duration: 150, y: -15 }} use:scroll>
      {#if results.length || loadingMore}
        <div class="messages" transition:customSlide|local={{ duration: 250 }}>
          {#each results as message (`${message.mailbox}-${message.id}`)}
            <div class="message" transition:customSlide|local={{ duration: 250 }}>
              <!-- Not bound: the each key is derived from `message` itself, so a
                   write-back lands in a reused block and overwrites an existing
                   row with another result (same bug as Mailbox/Mailbox.svelte).
                   SearchResult only mutates `message.flagged` in place. -->
              <SearchResult {message} mailbox={mailboxMap.get(message.mailbox)} bind:selection {query} />
            </div>
          {/each}
        </div>
        <div class="next-wrap">
          {#if loadingMore}
            <div class="loading-more">
              <CircularProgress />
            </div>
          {:else if nextCursor}
            <div class="next btn-dark" on:click={next}>
              <Plus />
              <Ripple />
            </div>
          {/if}
        </div>
      {:else}
        <div class="empty-wrap" in:customSlide|local={{duration: 250}}>
          <div class="empty">
            {$locale.There_are_no_search_results_for_this_query}
          </div>
        </div>
      {/if}
    </div>
  </div>
{/key}
