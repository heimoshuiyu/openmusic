import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router"
import { QueryClient } from "@tanstack/react-query"
import { api, ApiError } from "@/api/client"
import { AppLayout } from "@/components/app-layout"
import { LoginPage } from "@/pages/login"
import { HomePage } from "@/pages/home"
import { ArtistsPage } from "@/pages/artists"
import { ArtistPage } from "@/pages/artist"
import { AlbumsPage } from "@/pages/albums"
import { AlbumPage } from "@/pages/album"
import { TracksPage } from "@/pages/tracks"
import { SearchPage } from "@/pages/search"
import { PlaylistsPage } from "@/pages/playlists"
import { PlaylistPage } from "@/pages/playlist"
import { FavoritesPage } from "@/pages/favorites"
import { AdminPage } from "@/pages/admin"
import { ReviewDeletion } from "@/pages/review-deletion"

interface RouterContext {
  queryClient: QueryClient
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
})

const authGuard = async () => {
  try {
    await api.me()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw redirect({ to: "/login" })
    }
  }
}

const layoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "layout",
  component: AppLayout,
  beforeLoad: authGuard,
})

const homeRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/",
  component: HomePage,
})

const artistsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/artists",
  component: ArtistsPage,
})

export const artistRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/artists/$id",
  component: ArtistPage,
})

const albumsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/albums",
  component: AlbumsPage,
})

export const albumRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/albums/$id",
  component: AlbumPage,
})

const tracksRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/tracks",
  component: TracksPage,
})

const searchRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/search",
  component: SearchPage,
})

const playlistsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/playlists",
  component: PlaylistsPage,
})

export const playlistRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/playlists/$id",
  component: PlaylistPage,
})

const favoritesRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/favorites",
  component: FavoritesPage,
})

const adminRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/admin",
  component: AdminPage,
})

export const assistantRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/assistant",
  validateSearch: (search: Record<string, unknown>): {session?:string} =>
    typeof search.session === "string" && /^ses_[\w-]+$/.test(search.session) ? {session: search.session} : {},
  // The authenticated layout owns the workspace so docking never remounts the live conversation.
  component: () => null,
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
})

const reviewDeletionRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: "/review-deletion/$requestId",
  component: function Review() {
    const {requestId}=reviewDeletionRoute.useParams()
    return <ReviewDeletion key={requestId} requestId={requestId} />
  },
})

const routeTree = rootRoute.addChildren([
  loginRoute,
  layoutRoute.addChildren([
    homeRoute,
    artistsRoute,
    artistRoute,
    albumsRoute,
    albumRoute,
    tracksRoute,
    searchRoute,
    playlistsRoute,
    playlistRoute,
    favoritesRoute,
    adminRoute,
    assistantRoute,
    reviewDeletionRoute,
  ]),
])

export const router = createRouter({
  routeTree,
  context: { queryClient: undefined! },
  defaultPreload: "intent",
})

export function setupRouter(queryClient: QueryClient) {
  router.update({ context: { queryClient } })
}
