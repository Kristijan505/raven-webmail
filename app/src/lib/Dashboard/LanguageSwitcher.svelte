<script lang="ts">
  export let open = false;

  import Menu from "$lib/Menu/Menu.svelte";
  import MenuItem from "$lib/Menu/MenuItem.svelte";
  import Ripple from "$lib/Ripple.svelte";
  import PortalPopup from "$lib/PortalPopup.svelte";
  import Globe from "~icons/mdi/web";
  import Check from "~icons/mdi/check";
  import { lang, locale, persistLang } from "$lib/locale";
  import { action, _get } from "$lib/util";
  import { clickable } from "$lib/actions";

  const LANGS = [
    { code: "en", name: "English" },
    { code: "hr", name: "Hrvatski" },
    { code: "es", name: "Español" },
    { code: "it", name: "Italiano" },
  ];

  // Persist the choice and apply it live. The server honors ?accept-language as
  // an override, so no reload is needed — the stores update and every $locale
  // consumer re-renders. The saved value is re-applied by +layout.ts on reload.
  const choose = action(async (code: string) => {
    persistLang(code);
    const data = await _get(`/api/locale?accept-language=${encodeURIComponent(code)}`);
    lang.set(data.lang);
    locale.set(data.locale);
    open = false;
  });
</script>

<style>
  .wrap {
    position: relative;
    flex: none;
  }

  .anchor {
    position: absolute;
    bottom: 0;
    right: 0;
  }

  .lang-btn {
    width: 3rem;
    height: 3rem;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.4rem;
    border-radius: var(--radius-full);
    color: #fff;
  }
</style>

<div class="wrap">
  <div class="lang-btn btn-dark" class:hover={open} use:clickable={"Language"} on:click={() => open = !open}>
    <Globe />
    <Ripple />
  </div>

  <div class="anchor">
    <PortalPopup anchor="top-right" bind:open>
      <Menu>
        {#each LANGS as l}
          <MenuItem icon={$lang === l.code ? Check : undefined} iconPlaceholder on:click={() => choose(l.code)}>
            {l.name}
          </MenuItem>
        {/each}
      </Menu>
    </PortalPopup>
  </div>
</div>
