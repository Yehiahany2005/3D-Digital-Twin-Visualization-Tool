import {
  AlertTriangle,
  Bot,
  Box,
  ChevronRight,
  Copy,
  createElement,
  Eye,
  EyeOff,
  Focus,
  Layers,
  Lock,
  LockOpen,
  Package,
  Play,
  Square,
  Trash2,
  User,
  Wrench,
} from 'lucide';

const ICONS = { AlertTriangle, Bot, Box, ChevronRight, Copy, Eye, EyeOff, Focus, Layers, Lock, LockOpen, Package, Play, Square, Trash2, User, Wrench };

// An icon as an SVG element, for UI built in code (createIcons only handles the page's HTML).
export function icon(name, size = 14) {
  const node = ICONS[name] || Box;
  const element = createElement(node);
  element.setAttribute('width', String(size));
  element.setAttribute('height', String(size));
  element.setAttribute('aria-hidden', 'true');
  return element;
}

export function registerIcons(extra) {
  Object.assign(ICONS, extra);
}
