<script lang="ts">
  // "RedCode Mail" lockup: the <R/> mark followed by the "Mail" wordmark.
  // Used in every navbar/header in place of the old "Raven" text.
  import RedcodeLogo from "./RedcodeLogo.svelte";
  export let size = "1.2em";
</script>

<span class="brand">
  <RedcodeLogo {size} />
  <span class="word">Mail</span>
</span>

<style>
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    line-height: 1;
    white-space: nowrap;
  }

  .word {
    font-weight: 600;
    letter-spacing: 0.01em;
  }
</style>
