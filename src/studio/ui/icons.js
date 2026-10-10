import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bot,
  Box,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  createElement,
  Crosshair,
  Eye,
  EyeOff,
  Focus,
  Forklift,
  Grab,
  Grid3x3,
  Hand,
  House,
  LandPlot,
  Layers,
  Link,
  ListVideo,
  Lock,
  LockOpen,
  MapPin,
  Package,
  PackageCheck,
  PackageSearch,
  Pencil,
  Play,
  Plus,
  Power,
  Repeat,
  Scan,
  Square,
  Timer,
  Trash2,
  Unlink,
  User,
  WandSparkles,
  Wrench,
} from 'lucide';

const ICONS = {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Bot, Box, ChevronDown, ChevronRight, ChevronUp, ClipboardCopy, ClipboardPaste, Copy,
  Crosshair, Eye, EyeOff, Focus, Forklift, Grab, Grid3x3, Hand, House, LandPlot, Layers, Link, ListVideo, Lock, LockOpen, MapPin, Package,
  PackageCheck, PackageSearch, Pencil, Play, Plus, Power, Repeat, Scan, Square, Timer, Trash2, Unlink, User, WandSparkles, Wrench,
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
