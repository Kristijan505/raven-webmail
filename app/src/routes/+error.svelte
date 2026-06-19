<script lang="ts">
  export let status: number;
  export let error: Error;
  import Ripple from "$lib/Ripple.svelte";
  import { locale } from "$lib/locale";
  // Surface only the status to the user; log the raw error for debugging instead
  // of rendering its message (which can leak internals) in the heading.
  $: if (error) console.error("Page error:", error);
</script>

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
  <h1>{status}</h1>
  <p>{$locale.Error_message}</p>
  <a href="/" class="na btn-light btn-primary elev2">
    {$locale.Take_me_to_my_inbox}
    <Ripple />
  </a>
</div>
