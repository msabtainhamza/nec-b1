import { createContext, useContext, useEffect } from 'react';

export interface RecordActions {
  find?: () => void;
  add?: () => void;
  first?: () => void;
  previous?: () => void;
  next?: () => void;
  last?: () => void;
}

export const RecordToolbarContext = createContext<(actions: RecordActions | null) => void>(() => undefined);

export function useRecordToolbar(actions: RecordActions): void {
  const register = useContext(RecordToolbarContext);
  useEffect(() => {
    register(actions);
  });
  useEffect(() => () => register(null), [register]);
}
