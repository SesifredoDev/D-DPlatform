import { Routes } from '@angular/router';
import {Auth} from './pages/auth/auth';
import {Dashboard} from './pages/dashboard/dashboard';
import {AuthGuard} from './shared/guards/auth.guard';
import {Manage} from './pages/character/manage/manage';
export const routes: Routes = [
  {
    path: 'auth', component: Auth
  },
  {
    path:'', component:Dashboard, canActivate:[AuthGuard]
  },
  {
    path: 'characters', component:Manage, canActivate:[AuthGuard]
  }
];
