<script lang="ts">
  import { lang, locale } from "$lib/locale";
  import type { LayoutData } from "./$types";

  export let data: LayoutData;

  $: lang.set(data.lang);
  $: locale.set(data.locale);
</script>

<slot />
