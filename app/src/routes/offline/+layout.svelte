<script>
  import Brand from "$lib/Brand/Brand.svelte";
</script>

<style>
  .dash {
    width: 100%;
    min-height: 100%;
    background: var(--bg);
  }

  .top {
    height: var(--top-h);
    background: var(--red);/*  */
    color: #fff;
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  .logo {
    font-weight: 500;
    font-size: 1.25rem;
    margin: 0 var(--space-6);
  }
</style>

<div class="dash">
  <div class="top">
    <div class="logo"><Brand /></div>
  </div>

  <div class="page">
    <slot />
  </div>
</div>