<script lang="ts">
  export let username: string;
  import { page } from "$app/stores";
  let q = ($page.url.pathname === "/search" && $page.url.searchParams.get("query")) || "";

  import Menu from "~icons/mdi/menu";
  import AccountButton from "./AccountButton.svelte";
  import Brand from "$lib/Brand/Brand.svelte";
  import LanguageSwitcher from "./LanguageSwitcher.svelte";
  import ThemeSwitcher from "./ThemeSwitcher.svelte";

  import { getContext } from "svelte";
  import type { DashContext } from "./Dashboard.svelte";
  import Ripple from "$lib/Ripple.svelte";
  const { toggle, mailboxes } = getContext("dash") as DashContext;

  import Magnify from "~icons/mdi/magnify";
  import { goto } from "$app/navigation";
  import { locale } from "$lib/locale";
  import { clickable } from "$lib/actions";
  import { isInbox } from "$lib/util";

  let searching = false;
  const onkeypress = async (event: KeyboardEvent) => {
    if(event.key === "Enter") {
      let _q = q.trim();
      if(_q) {
        try {
          await goto(`/search?query=${encodeURIComponent(_q)}`, { keepFocus: true, replaceState: location.pathname === "/search" })
        } finally {
          searching = false;
        }
      }
    }
  }

  // The logo doubles as a home button: jump to the inbox on click
  // (mailboxes[0] is the inbox; the bare "/" route redirects there too).
  $: inbox = $mailboxes.find(isInbox) ?? $mailboxes[0];
  $: inboxHref = inbox ? `/mailbox/${inbox.id}` : "/";
</script>

<style>
  .top {
    height: var(--top-h);
    color: #fff;
    display: flex;
    flex-direction: row;
    align-items: center;
    flex: none;
    background: var(--red);
  }

  .menu {
    width: 4rem;
    height: 4rem;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.75rem;
    flex: none;
    border-radius: 0;
    padding: 0;
  }

  .logo {
    font-weight: 500;
    font-size: 1.25rem;
    margin-inline-end: 1rem;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
    transition: opacity 150ms ease;
  }

  .logo:hover {
    opacity: 0.85;
  }

  @media screen and (max-width: 600px) {
    .logo {
      display: none;
    }
  }

  .q-wrap-wrap {
    margin-inline-end: 0.75rem;
    display: flex;
    flex: 1;
    flex-basis: 14rem;
  }

  .q-wrap {
    flex: 1;
    position: relative;
    display: flex;
    max-width: 45rem;
    margin: 0 auto;
  }

  .search-icon {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    left: 0.65rem;
    display: flex;
    font-size: 1.25rem;
    align-items: center;
    justify-content: center;
    color: rgba(255,255,255,0.8);
    margin-inline-end: 1rem;
  }

  .q {
    display: block;
    flex: 1;
    padding: 0.6rem 1rem 0.6rem 2.5rem;
    border-radius: 100px;
    border: 0;
    outline: 0;
    font: inherit;
    background: rgba(255,255,255,0.25);
    font-size: 0.95rem;
    color: #fff;
  }

  .q::placeholder {
    color: rgba(255,255,255,0.8);
  }
</style>

<div class="top">
  <div class="menu btn-light" use:clickable on:click={toggle}>
    <Menu />
    <Ripple />
  </div>
  <a class="logo na" href={inboxHref} aria-label={$locale.mailboxes.Inbox} title={$locale.mailboxes.Inbox}>
    <Brand />
  </a>
  <div class="q-wrap-wrap">
    <div class="q-wrap">
      <div class="search-icon">
        <Magnify />
      </div>
      <input type="text" on:keypress={onkeypress} class="q" placeholder={$locale["Search..."]} bind:value={q} />
    </div>
  </div>
  <ThemeSwitcher />
  <LanguageSwitcher />
  <AccountButton {username} />
</div>
