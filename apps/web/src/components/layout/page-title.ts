import {
  createContext,
  useContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

export const PageTitleValue = createContext<ReactNode>(null);
export const PageTitleSetter = createContext<Dispatch<SetStateAction<ReactNode>> | null>(null);

export function usePageTitle(): ReactNode {
  return useContext(PageTitleValue);
}
