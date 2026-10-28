export interface SeedFloor {
  id: string;
  name: string;
  levelOrder: number;
  /** Nome icona Lucide mostrato nel selettore dei piani. */
  icon: string;
}

/**
 * Piani di una casa nuova. `level_order` decide l'ordine del selettore: 0 è il
 * piano terra. Le stanze del seed dichiarano `floorId`, così la planimetria è
 * già popolata al primo avvio e l'amministratore la corregge invece di
 * ricostruirla da zero.
 */
export const SEED_FLOORS: readonly SeedFloor[] = [
  { id: 'piano-terra', name: 'Piano terra', levelOrder: 0, icon: 'Layers' },
  { id: 'primo-piano', name: 'Primo piano', levelOrder: 1, icon: 'Building2' },
];
