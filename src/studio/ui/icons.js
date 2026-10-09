import {
  AlertTriangle,
  Bot,
  Box,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  createElement,
  Crosshair,
  Eye,
  EyeOff,
  Focus,
  Grab,
  Grid3x3,
  Hand,
  House,
  Layers,
  ListVideo,
  Lock,
  LockOpen,
  Package,
  PackageSearch,
  Play,
  Plus,
  Power,
  Repeat,
  Square,
  Timer,
  Trash2,
  User,
  WandSparkles,
  Wrench,
} from 'lucide';

const ICONS = {
  AlertTriangle, Bot, Box, ChevronDown, ChevronRight, ChevronUp, Copy, Crosshair, Eye, EyeOff, Focus, Grab, Grid3x3, Hand, House, Layers,
  ListVideo, Lock, LockOpen, Package, PackageSearch, Play, Plus, Power, Repeat, Square, Timer, Trash2, User, WandSparkles, Wrench,
};

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
