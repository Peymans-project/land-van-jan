FROM mongo:8.0.28

COPY entrypoint.sh /usr/local/bin/land-van-jan-mongo-entrypoint
RUN chmod 755 /usr/local/bin/land-van-jan-mongo-entrypoint

ENTRYPOINT ["/usr/local/bin/land-van-jan-mongo-entrypoint"]
CMD ["mongod", "--ipv6", "--bind_ip", "::,0.0.0.0", "--setParameter", "diagnosticDataCollectionEnabled=false", "--auth", "--replSet", "rs0", "--keyFile", "/tmp/mongodb-keyfile"]
