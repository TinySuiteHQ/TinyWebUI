/**
 * The transcript's one scroll owner. It follows new output while the reader
 * is at the bottom and leaves them where they are once they scroll up; layout
 * that changes on its own (images decoding, the activity folding, the
 * composer growing) is caught by watching sizes, not by every writer
 * remembering to scroll.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

// Within this many pixels of the end still counts as "at the bottom".
const SLACK = 60;

export function useStickToBottom(scroller: Ref<HTMLElement | undefined>, content: Ref<HTMLElement | undefined>) {
  const pinned = ref(true);
  let observer: ResizeObserver | undefined;

  const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < SLACK;
  function toBottom() {
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  }
  function onScroll() {
    if (scroller.value) pinned.value = atBottom(scroller.value);
  }
  /** Back to the newest output, following again (a chat switch, Jump to latest). */
  function pin() {
    pinned.value = true;
    requestAnimationFrame(toBottom);
  }

  onMounted(() => {
    observer = new ResizeObserver(() => { if (pinned.value) toBottom(); });
    if (scroller.value) observer.observe(scroller.value);
    if (content.value) observer.observe(content.value);
    scroller.value?.addEventListener('scroll', onScroll, { passive: true });
  });
  onBeforeUnmount(() => {
    observer?.disconnect();
    scroller.value?.removeEventListener('scroll', onScroll);
  });

  return { pinned, pin, toBottom };
}
