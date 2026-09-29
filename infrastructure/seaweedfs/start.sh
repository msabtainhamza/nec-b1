#!/bin/sh
set -e
mkdir -p /data /tmp/seaweedfs
cat > /tmp/seaweedfs/s3.json <<JSON
{"identities":[{"name":"local","credentials":[{"accessKey":"${S3_ACCESS_KEY}","secretKey":"${S3_SECRET_KEY}"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
JSON
exec weed server -dir=/data -ip.bind=0.0.0.0 -s3 -s3.port=8333 -s3.config=/tmp/seaweedfs/s3.json
