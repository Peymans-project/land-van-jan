# Railway MongoDB replica set

This image runs the official MongoDB 8 image as a single-node replica set. The
application uses MongoDB transactions, so a standalone `mongod` is not a safe
production target.

Required server-side variables:

- `MONGO_INITDB_ROOT_USERNAME`
- `MONGO_INITDB_ROOT_PASSWORD`
- `MONGO_REPLICA_KEY`

Attach a persistent volume at `/data/db`. After the first deployment, initiate
the replica set once with the private Railway hostname as its sole member. Keep
this service private; the application connects over Railway's private network.

Never commit the values of these variables or the generated connection URI.
