# Astral Project

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.0.0.

## Development index

To start a local development index, run:

```bash
ng serve
```

Once the index is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

To run the frontend in a Tauri desktop shell, run:

```bash
npm run tauri:dev
```

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

To create a Tauri desktop build, run:

```bash
npm run tauri:build
```

## Production desktop CORS

The installed Tauri bundle serves the Angular app from the custom `astralproject`
protocol. On Windows and Android the production origin is
`https://astralproject.localhost`; on macOS and Linux it is
`astralproject://localhost`. The production API must allow the exact desktop origin
explicitly because the app sends credentialed requests to
`https://dissertation.pchaffey.me/api/...`.

For nginx, put the `map` in the `http` block and the `/api/` handling in the
`server` block that proxies `dissertation.pchaffey.me`:

```nginx
map $http_origin $cors_origin {
  default "";
  "https://dissertation.pchaffey.me" $http_origin;
  "https://astralproject.localhost" $http_origin;
  "astralproject://localhost" $http_origin;
  "http://localhost:4200" $http_origin;
}

location /api/ {
  if ($request_method = OPTIONS) {
    add_header Access-Control-Allow-Origin $cors_origin always;
    add_header Access-Control-Allow-Credentials "true" always;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type, X-Requested-With" always;
    add_header Access-Control-Max-Age 86400 always;
    add_header Vary Origin always;
    return 204;
  }

  add_header Access-Control-Allow-Origin $cors_origin always;
  add_header Access-Control-Allow-Credentials "true" always;
  add_header Vary Origin always;

  proxy_pass http://backend;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

If CORS is handled in the API app instead of nginx, allow these same origins
there and keep `credentials: true`. Refresh/login cookies also need
`SameSite=None; Secure; HttpOnly` in production so the Tauri origin can send
them back to the HTTPS API.

## Running unit tests

To execute unit tests with the [Karma](https://karma-runner.github.io) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.

