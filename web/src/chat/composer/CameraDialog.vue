<script setup lang="ts">
/**
 * "Take photo" on a computer: a webcam preview and a shutter. The shot is
 * handed back as a File and staged like any picked image; the camera is
 * released the moment the dialog goes, whichever way it goes.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Modal from '../../ui/Modal.vue';

const emit = defineEmits<{ close: [], photo: [file: File] }>();
const video = ref<HTMLVideoElement>();
const stream = ref<MediaStream | null>(null);
const error = ref('');
const shot = ref<{ file: File, url: string } | null>(null);

function stop() {
  for (const t of stream.value?.getTracks() || []) t.stop();
  stream.value = null;
}

async function start() {
  error.value = '';
  try {
    stream.value = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    if (video.value) video.value.srcObject = stream.value;
  } catch (err) {
    const name = (err as { name?: string }).name;
    error.value = name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in the browser to take a photo.'
      : name === 'NotFoundError' ? 'No camera was found.'
      : `Could not start the camera: ${(err as Error).message}`;
  }
}

function capture() {
  const v = video.value;
  if (!v || !v.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  canvas.getContext('2d')?.drawImage(v, 0, 0);
  canvas.toBlob((blob) => {
    if (!blob) { error.value = 'Could not take the photo.'; return; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = new File([blob], `photo-${stamp}.jpg`, { type: 'image/jpeg' });
    shot.value = { file, url: URL.createObjectURL(blob) };
  }, 'image/jpeg', 0.9);
}

function retake() {
  if (shot.value) URL.revokeObjectURL(shot.value.url);
  shot.value = null;
}
function use() {
  if (!shot.value) return;
  emit('photo', shot.value.file);
  emit('close');
}

onMounted(start);
onBeforeUnmount(() => { stop(); retake(); });
</script>

<template>
  <Modal id="cameraDialog" labelledby="cameraTitle" @close="emit('close')">
    <h2 id="cameraTitle">Take photo</h2>
    <div class="camera-frame">
      <div v-if="error" class="empty">{{ error }}</div>
      <div v-else-if="!stream && !shot" class="empty">Starting the camera… allow access if the browser asks.</div>
      <!-- Mirrored only on screen, like a mirror; the photo itself is not. -->
      <video v-show="stream && !error && !shot" ref="video" class="camera-live" autoplay playsinline muted />
      <img v-if="shot" :src="shot.url" alt="The photo just taken">
    </div>
    <div class="dialog-actions">
      <button type="button" @click="emit('close')">cancel</button>
      <template v-if="shot">
        <button type="button" @click="retake">retake</button>
        <button type="button" class="primary" @click="use">use photo</button>
      </template>
      <button v-else type="button" class="primary" :disabled="!stream || Boolean(error)" @click="capture">take photo</button>
    </div>
  </Modal>
</template>
