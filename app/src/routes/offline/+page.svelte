<script lang="ts">
  import { locale } from "$lib/locale";
  import Ripple from "$lib/Ripple.svelte";
</script>

<svelte:head>
  <title>{$locale.Offline_title}</title>
</svelte:head>

<style>
  .page {
    padding: var(--space-8);
  }

  p {
    font-size: 1.25rem;
    margin-bottom: var(--space-12);
  }
</style>

<div class="page">
  <h1>{$locale.Offline_title}</h1>
  <p>{$locale.Offline_message}</p>
  <button class="btn-light btn-primary elev2" on:click={() => window.location.reload()}>
    {$locale.Retry}
    <Ripple />
  </button>
</div>
