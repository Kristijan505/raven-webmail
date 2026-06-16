<script>
  import { watchAuth } from "$lib/util";
  import { onMount } from "svelte";
  import { fly } from "svelte/transition";
  import Brand from "$lib/Brand/Brand.svelte";
  import ThemeSwitcher from "$lib/Dashboard/ThemeSwitcher.svelte";
  import LanguageSwitcher from "$lib/Dashboard/LanguageSwitcher.svelte";
  onMount(() => watchAuth(null));
</script>

<style>
  .dash {
    width: 100%;
    min-height: 100%;
    background: var(--bg);
  }

  .top {
    height: var(--top-h);
    background: var(--red);
    color: #fff;
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  .logo {
    font-weight: 500;
    font-size: 1.25rem;
    margin: 0 1.5rem;
  }

  .actions {
    margin-inline-start: auto;
    margin-inline-end: 0.75rem;
    display: flex;
    align-items: center;
  }
</style>

<div class="dash" in:fly|local={{duration: 400, y: -25}}>
  <div class="top">
    <div class="logo">
      <Brand />
    </div>
    <div class="actions">
      <ThemeSwitcher />
      <LanguageSwitcher />
    </div>
  </div>

  <div class="page">
    <slot />
  </div>
</div>
