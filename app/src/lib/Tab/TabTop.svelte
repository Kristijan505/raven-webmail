<script lang="ts">
  export let scrolled = false;
</script>

<style>
  .tab-top {
    display: flex;
    flex-direction: row;
    align-items: center;
    transition: box-shadow var(--duration) ease;
    height: 3rem;
    border-bottom: var(--border) 1px solid;
    flex: none;
    color: var(--text);
    position: relative;
    z-index: var(--z-sticky);
  }

  .tab-top :global(.action-group) {
    display: flex;
    flex-direction: row;
    padding: 0 var(--space-1);
    flex: none;
  }

  .tab-top :global(.action) {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    font-size: 1.35rem;
    border-radius: var(--radius-full);
    padding: var(--space-3);
    margin: 0 calc(-1 * var(--space-1));
    flex: none;
  }

  .scrolled {
    box-shadow: rgb(0 0 0 / 30%) 0 0.35em 0.15em -0.2em;
  }
</style>

<div class="tab-top" class:scrolled>
  <slot />
</div>