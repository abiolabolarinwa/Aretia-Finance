/** Shared shapes for the guided tour engine. Plain data, so a tour is just a config object. */

export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'auto';

export interface TourStep {
  /** CSS selector of the element to highlight. Leave out for a centred step with no spotlight. */
  target?: string;
  title: string;
  body: string;
  placement?: Placement;
  /** Page the host should open before this step (the wallet maps it to a view such as "swap"). */
  view?: string;
  /** Runs before the target is looked up, for example to open a tab. May be async. */
  beforeShow?: () => void | Promise<void>;
  /** Runs once the step is on screen. */
  afterShow?: (el: Element | null) => void;
}

export interface TourConfig {
  id: string;
  /** Short name shown in the Tours list. */
  title: string;
  description?: string;
  /** Left out of the Tours list (for tours that only start by themselves). */
  hidden?: boolean;
  /** Bump this after a content change so people who finished the old version see the tour again. */
  version: number;
  steps: TourStep[];
}

export type TourStatus = 'in-progress' | 'skipped' | 'completed';

export interface TourRecord {
  version: number;
  status: TourStatus;
  step: number;
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}
