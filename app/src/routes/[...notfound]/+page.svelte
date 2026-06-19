<script lang="ts">
  import Ripple from "$lib/Ripple.svelte";
  import { locale } from "$lib/locale";
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
  <h1>404 {$locale.Not_found}</h1>
  <p>{$locale.Page_not_found}</p>
  <a href="/" class="na btn-primary elev2">
    {$locale.Take_me_to_my_inbox}
    <Ripple />
  </a>
</div>
