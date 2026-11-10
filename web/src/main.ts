import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './app/App.vue';
import './styles/base.css';
import './styles/chat.css';

createApp(App).use(createPinia()).mount('#app');
