<script lang="ts">
  export let open = false;

  import Menu from "$lib/Menu/Menu.svelte";
  import MenuItem from "$lib/Menu/MenuItem.svelte";
  import Ripple from "$lib/Ripple.svelte";
  import PortalPopup from "$lib/PortalPopup.svelte";
  import ThemeIcon from "~icons/mdi/theme-light-dark";
  import Sun from "~icons/mdi/white-balance-sunny";
  import Moon from "~icons/mdi/weather-night";
  import AutoIcon from "~icons/mdi/brightness-auto";
  import Check from "~icons/mdi/check";
  import { theme, setTheme, type Theme } from "$lib/theme";
  import { locale } from "$lib/locale";
  import { clickable } from "$lib/actions";

  const OPTS: { value: Theme; icon: any }[] = [
    { value: "light", icon: Sun },
    { value: "dark", icon: Moon },
    { value: "auto", icon: AutoIcon },
  ];

  $: label = {
    light: $locale.theme.Light,
    dark: $locale.theme.Dark,
    auto: $locale.theme.Auto,
  } as Record<Theme, string>;

  const choose = (t: Theme) => {
    setTheme(t);
    open = false;
  };
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

  .theme-btn {
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
  <div class="theme-btn btn-dark" class:hover={open} use:clickable={$locale.theme.Theme} on:click={() => open = !open}>
    <ThemeIcon />
    <Ripple />
  </div>

  <div class="anchor">
    <PortalPopup anchor="top-right" bind:open>
      <Menu>
        {#each OPTS as o}
          <MenuItem icon={$theme === o.value ? Check : o.icon} iconPlaceholder on:click={() => choose(o.value)}>
            {label[o.value]}
          </MenuItem>
        {/each}
      </Menu>
    </PortalPopup>
  </div>
</div>
