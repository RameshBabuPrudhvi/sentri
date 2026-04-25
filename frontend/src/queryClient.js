/**
 * @module queryClient
 * @description Shared TanStack Query client and query keys.
 */

import { QueryClient } from "@tanstack/react-query";

export const projectDataQueryKeys = {
  root: ["projectData"],
  projects: ["projectData", "projects"],
  runs: ["projectData", "runs"],
  tests: ["projectData", "tests"],
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
