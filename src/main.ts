import './styles.css';
import { bootstrapApp } from './app';

const root = document.getElementById('app');

if (!root) {
  throw new Error('Daynora root element was not found.');
}

void bootstrapApp(root);
