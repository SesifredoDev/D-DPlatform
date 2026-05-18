import { HttpErrorResponse } from '@angular/common/http';
import { throwError } from 'rxjs';
import type { ApiError } from '../models/utils/api-error.util.model';
export type { ApiError } from '../models/utils/api-error.util.model';
export function handleApiError(error: HttpErrorResponse) {
  const apiError: ApiError = {
    status: error.status,
    message:
      error.error?.message ||
      error.message ||
      'An unexpected error occurred'
  };

  console.error('API Error:', apiError);
  return throwError(() => apiError);
}
